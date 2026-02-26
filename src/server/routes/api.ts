import express from "express";
import multer from "multer";
import type { AppLogger } from "../../logger/index.js";
import { parseDocx } from "../../docx/parser.js";
import { detectAigcRisk } from "../../analysis/detector.js";
import { patchDocxParagraphs } from "../../docx/patcher.js";
import { rewriteParagraphWithDashscope } from "../../llm/rewriter.js";
import { chatRewrite } from "../../llm/chatRewriter.js";
import { judgeParagraphWithDashscope } from "../../llm/judge.js";
import { randomUUID } from "node:crypto";
import {
  getAccountIdFromRequestHeader,
  getDefaultFreePoints,
  isAdminRequest,
  verifyAdminSecret,
  listAllAccounts,
  ledger,
} from "../../billing/index.js";
import { HttpError } from "../errors.js";
import type { SessionStore } from "../sessionStore.js";
import { asyncHandler } from "./asyncHandler.js";
import { z } from "zod";

/**
 * API 路由：先保证“上传→拿到session→可导出原文”可跑通。
 *
 * 设计原因：
 * - 智能体链路较长，先把 IO（上传/下载）打通，后续逐步填充解析/检测/改写能力。
 * - 使用内存存储，避免引入数据库依赖，方便你在本地直接运行验证。
 */
export function createApiRouter(params: {
  logger: AppLogger;
  store: SessionStore;
}) {
  const router = express.Router();

  const maxUploadMb = Number(process.env.MAX_UPLOAD_MB ?? "20");
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadMb * 1024 * 1024 },
  });

  router.get("/health", (_req, res) => res.json({ ok: true }));

  router.get(
    "/billing/balance",
    asyncHandler(async (req, res) => {
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());
      res.json({ ok: true, accountId, balance: ledger.getBalance(accountId) });
    })
  );

  router.get(
    "/billing/transactions",
    asyncHandler(async (req, res) => {
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());
      res.json({ ok: true, accountId, transactions: ledger.listTransactions(accountId, 30) });
    })
  );

  router.post(
    "/billing/topup",
    asyncHandler(async (req, res) => {
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());
      const body = z.object({ points: z.number().int().min(1).max(100000) }).parse(req.body);
      const tx = ledger.topup(accountId, body.points, { source: "manual" });
      res.json({ ok: true, accountId, balance: ledger.getBalance(accountId), tx });
    })
  );

  router.post(
    "/upload",
    upload.single("file"),
    asyncHandler(async (req, res) => {
      const log = req.log ?? params.logger;
      const file = req.file;
      if (!file) throw new HttpError(400, "NO_FILE", "请上传 .docx 文件（字段名：file）");

      const decodedFilename = decodeMulterFilename(file.originalname);

      if (!decodedFilename.toLowerCase().endsWith(".docx")) {
        throw new HttpError(400, "INVALID_FILE", "目前仅支持 .docx");
      }

      const session = params.store.create({
        filename: decodedFilename,
        originalDocx: file.buffer,
      });

      log.info("Uploaded docx", {
        sessionId: session.sessionId,
        filename: session.filename,
        size: file.size,
      });

      const parsed = await parseDocx(file.buffer);
      const paragraphs = parsed.paragraphs.map((p) => ({
        id: p.id,
        index: p.index,
        text: p.text,
        kind: p.kind,
      }));

      const reportBefore = detectAigcRisk(paragraphs);

      // LLM 复核：对规则检测分 >= 50 的段落调用大模型二次审核
      // 按分数降序，最多 30 段 + 30 并发，确保 Zeabur 30s 超时内完成
      const MAX_JUDGE = 30;
      const candidatesForJudge = reportBefore.paragraphReports
        .filter((r) => r.riskScore >= 50)
        .sort((a, b) => b.riskScore - a.riskScore)
        .slice(0, MAX_JUDGE);

      if (candidatesForJudge.length > 0 && process.env.DASHSCOPE_API_KEY) {
        log.info("Starting LLM judge review", {
          sessionId: session.sessionId,
          candidateCount: candidatesForJudge.length,
        });

        const batchSize = 30;
        for (let bi = 0; bi < candidatesForJudge.length; bi += batchSize) {
          const batch = candidatesForJudge.slice(bi, bi + batchSize);
          const judgeResults = await Promise.allSettled(
            batch.map((r) =>
              judgeParagraphWithDashscope({
                logger: log,
                paragraphText: r.text,
                signals: r.signals,
              })
            )
          );

          for (let j = 0; j < batch.length; j++) {
            const result = judgeResults[j];
            if (result.status !== "fulfilled") continue;

            const judgeOutput = result.value;
            const paraReport = batch[j];

            // 加权融合：规则分 * 0.4 + LLM 分 * 0.6
            const fused = Math.round(
              paraReport.riskScore * 0.4 + judgeOutput.riskScore0to100 * 0.6
            );
            paraReport.riskScore = Math.min(100, Math.max(0, fused));
            paraReport.riskLevel =
              paraReport.riskScore >= 70
                ? "high"
                : paraReport.riskScore >= 35
                  ? "medium"
                  : "low";

            // LLM 理由追加为额外信号
            if (judgeOutput.topReasons?.length) {
              paraReport.signals.push({
                signalId: "llm_judge_review",
                category: "aiPattern",
                title: "AI 复核判断",
                evidence: judgeOutput.topReasons.slice(0, 3),
                suggestion: judgeOutput.shouldRewrite
                  ? "建议对此段落进行改写以降低 AI 痕迹。"
                  : "AI 复核认为此段落风险可控。",
                score: 0, // 分数已经融合，不再额外加分
              });
            }
          }
        }

        // 重新计算文档整体分（对齐知网标准：AI字符数占比）
        let aiChars = 0, allChars = 0;
        for (const r of reportBefore.paragraphReports) {
          const len = r.text.length;
          allChars += len;
          if (r.riskScore >= 35) aiChars += len * (r.riskScore / 100);
        }
        reportBefore.overallRiskScore = allChars > 0
          ? Math.min(100, Math.max(0, Math.round((aiChars / allChars) * 100)))
          : 0;
        reportBefore.overallRiskLevel =
          reportBefore.overallRiskScore >= 70 ? "high" : reportBefore.overallRiskScore >= 35 ? "medium" : "low";

        log.info("LLM judge review completed", {
          sessionId: session.sessionId,
          overallScore: reportBefore.overallRiskScore,
        });
      }

      params.store.update(session.sessionId, {
        paragraphs: parsed.paragraphs.map((p) => ({
          id: p.id,
          index: p.index,
          text: p.text,
          kind: p.kind,
        })),
        reportBefore,
        reportAfter: undefined,
        revised: {},
        rewriteResults: {},
        revision: 0,
        revisedDocx: undefined,
        revisedDocxRevision: undefined,
      });

      log.info("Parsed docx paragraphs", {
        sessionId: session.sessionId,
        paragraphCount: parsed.paragraphs.length,
      });

      res.json({
        ok: true,
        sessionId: session.sessionId,
        paragraphCount: parsed.paragraphs.length,
        report: reportBefore,
        message: "上传并解析成功：已生成AIGC检测报告（下一步可对高风险段落执行改写）",
      });
    })
  );

  router.get(
    "/sessions",
    asyncHandler(async (req, res) => {
      const limit = Number(req.query.limit ?? "30");
      const xs = params.store.list(Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 30);
      res.json({ ok: true, sessions: xs });
    })
  );

  router.get(
    "/session/:sessionId",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");

      res.json({
        ok: true,
        sessionId,
        filename: session.filename,
        createdAt: session.createdAt,
        revision: session.revision ?? 0,
        paragraphs: session.paragraphs ?? [],
        reportBefore: session.reportBefore ?? null,
        reportAfter: session.reportAfter ?? null,
        revised: session.revised ?? {},
        rewriteResults: session.rewriteResults ?? {},
        chatMessages: session.chatMessages ?? [],
        exportUrl: `/api/export/${encodeURIComponent(sessionId)}`,
      });
    })
  );

  router.get(
    "/report/:sessionId",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");
      if (!session.reportBefore) throw new HttpError(404, "REPORT_NOT_FOUND", "该会话尚未生成报告");
      res.json({ ok: true, sessionId, report: session.reportBefore });
    })
  );

  router.post(
    "/rewrite/:sessionId",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");
      if (!session.paragraphs?.length) throw new HttpError(400, "NO_PARAGRAPHS", "该会话没有可改写段落");
      if (!session.reportBefore) throw new HttpError(400, "NO_REPORT", "请先生成检测报告");

      const bodySchema = z.object({
        paragraphIds: z.array(z.string()).min(1).max(30),
      });
      const body = bodySchema.parse(req.body);
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      const isAdmin = isAdminRequest(req.header("x-admin-secret"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = session.reportBefore as any;
      const paraReports: Array<{ paragraphId: string; signals: any[]; riskScore: number }> =
        report.paragraphReports ?? [];

      const updated: Record<string, string> = { ...(session.revised ?? {}) };
      const rewriteResults: NonNullable<(typeof session)["rewriteResults"]> = {
        ...(session.rewriteResults ?? {}),
      };
      const details: Array<{ paragraphId: string; revisedPreview: string; resolvedSignalIds: string[] }> = [];

      for (const pid of body.paragraphIds) {
        const p = session.paragraphs.find((x) => x.id === pid);
        if (!p) throw new HttpError(400, "INVALID_PARAGRAPH", `段落不存在：${pid}`);

        const pr = paraReports.find((x) => x.paragraphId === pid);
        const signals = Array.isArray(pr?.signals) ? pr.signals : [];

        const before = session.paragraphs[p.index - 1]?.text;
        const after = session.paragraphs[p.index + 1]?.text;

        const chargedPoints = estimateRewritePoints(p.text);

        // 管理员无限积分，跳过扣费
        if (!isAdmin) {
          try {
            ledger.charge(accountId, chargedPoints, { sessionId, paragraphId: pid });
          } catch (e) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const code = (e as any)?.code;
            if (code === "INSUFFICIENT_POINTS") {
              throw new HttpError(402, "INSUFFICIENT_POINTS", "积分不足：请联系管理员充值");
            }
            throw e;
          }
        }

        let rewritten: { revisedText: string; riskSignalsResolved: string[] };
        try {
          const full = await rewriteParagraphWithDashscope({
            logger: req.log ?? params.logger,
            paragraphText: p.text,
            contextBefore: before,
            contextAfter: after,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            signals: signals as any,
          });
          rewritten = { revisedText: full.revisedText, riskSignalsResolved: full.riskSignalsResolved };

          rewriteResults[pid] = {
            revisedText: full.revisedText,
            changeRationale: full.changeRationale ?? [],
            riskSignalsResolved: full.riskSignalsResolved ?? [],
            needHumanCheck: full.needHumanCheck ?? [],
            humanFeatures: full.humanFeatures ?? [],
            chargedPoints,
            createdAt: Date.now(),
          };
        } catch (e) {
          if (!isAdmin) {
            try {
              ledger.refund(accountId, chargedPoints, { sessionId, paragraphId: pid, reason: "rewrite_failed" });
            } catch { /* 退款失败不阻塞 */ }
          }
          const msg = e instanceof Error ? e.message : String(e);
          if (/Missing DASHSCOPE_API_KEY/i.test(msg)) {
            throw new HttpError(
              400,
              "MISSING_DASHSCOPE_API_KEY",
              "未配置 DASHSCOPE_API_KEY：请先按 .env.example 设置环境变量后再改写"
            );
          }
          throw e;
        }

        updated[pid] = rewritten.revisedText;
        details.push({
          paragraphId: pid,
          revisedPreview: rewritten.revisedText.slice(0, 80),
          resolvedSignalIds: rewritten.riskSignalsResolved,
        });
      }

      const revision = (session.revision ?? 0) + 1;
      const mergedParagraphs = session.paragraphs.map((p) => ({
        id: p.id,
        index: p.index,
        kind: p.kind,
        text: updated[p.id] ?? p.text,
      }));
      const reportAfter = detectAigcRisk(mergedParagraphs);

      params.store.update(sessionId, {
        revised: updated,
        rewriteResults,
        reportAfter,
        revision,
        // 下次导出时再回写 docx（避免每批改写都重打包）
        revisedDocx: undefined,
        revisedDocxRevision: undefined,
      });

      res.json({
        ok: true,
        sessionId,
        rewrittenCount: body.paragraphIds.length,
        exportUrl: `/api/export/${encodeURIComponent(sessionId)}`,
        details,
        reportAfter,
        billing: { accountId, balance: ledger.getBalance(accountId) },
      });
    })
  );

  router.post(
    "/recheck/:sessionId",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");
      if (!session.paragraphs?.length) throw new HttpError(400, "NO_PARAGRAPHS", "该会话没有可复检段落");
      if (!session.reportBefore) throw new HttpError(400, "NO_REPORT", "请先生成检测报告");

      const updated: Record<string, string> = { ...(session.revised ?? {}) };
      const mergedParagraphs = session.paragraphs.map((p) => ({
        id: p.id,
        index: p.index,
        kind: p.kind,
        text: updated[p.id] ?? p.text,
      }));
      const reportAfter = detectAigcRisk(mergedParagraphs);
      params.store.update(sessionId, { reportAfter });

      res.json({ ok: true, sessionId, reportAfter });
    })
  );

  router.get(
    "/export/:sessionId",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");

      const hasRevised = session.revised && Object.keys(session.revised).length > 0;
      let buf = session.originalDocx;
      let isRevised = false;
      if (hasRevised) {
        const curRev = session.revision ?? 0;
        if (!session.revisedDocx || session.revisedDocxRevision !== curRev) {
          const revisedDocx = await patchDocxParagraphs(session.originalDocx, session.revised ?? {});
          params.store.update(sessionId, { revisedDocx, revisedDocxRevision: curRev });
          buf = revisedDocx;
        } else {
          buf = session.revisedDocx;
        }
        isRevised = true;
      }

      const outName = isRevised
        ? session.filename.replace(/\\.docx$/i, "") + "-revised.docx"
        : session.filename;

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(outName)}`
      );
      res.send(buf);
    })
  );

  // ────────────────────────────────────────────────────
  // 聊天式改写：发送消息
  // ────────────────────────────────────────────────────
  router.post(
    "/chat/:sessionId",
    asyncHandler(async (req, res) => {
      const log = req.log ?? params.logger;
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");
      if (!session.paragraphs?.length) throw new HttpError(400, "NO_PARAGRAPHS", "该会话没有段落数据");
      if (!session.reportBefore) throw new HttpError(400, "NO_REPORT", "请先生成检测报告");

      const bodySchema = z.object({
        paragraphId: z.string().min(1),
        message: z.string().min(1).max(2000),
      });
      const body = bodySchema.parse(req.body);
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      const isAdmin = isAdminRequest(req.header("x-admin-secret"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());

      const p = session.paragraphs.find((x) => x.id === body.paragraphId);
      if (!p) throw new HttpError(400, "INVALID_PARAGRAPH", `段落不存在：${body.paragraphId}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = session.reportBefore as any;
      const pr = (report.paragraphReports ?? []).find(
        (x: { paragraphId: string }) => x.paragraphId === body.paragraphId
      );
      const signals = Array.isArray(pr?.signals) ? pr.signals : [];

      const existing = (session.chatMessages ?? []).filter(
        (m) => m.paragraphId === body.paragraphId
      );
      const history = existing.map((m) => ({ role: m.role, content: m.content }));

      const chargedPoints = estimateRewritePoints(p.text);
      if (!isAdmin) {
        try {
          ledger.charge(accountId, chargedPoints, { sessionId, paragraphId: body.paragraphId, type: "chat" });
        } catch (e) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((e as any)?.code === "INSUFFICIENT_POINTS") {
            throw new HttpError(402, "INSUFFICIENT_POINTS", "积分不足：请联系管理员充值");
          }
          throw e;
        }
      }

      let result: { reply: string; revisedText: string };
      try {
        result = await chatRewrite({
          logger: log,
          paragraphText: session.revised?.[body.paragraphId] ?? p.text,
          paragraphIndex: p.index,
          contextBefore: session.paragraphs[p.index - 1]?.text,
          contextAfter: session.paragraphs[p.index + 1]?.text,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          signals: signals as any,
          history,
          userMessage: body.message,
        });
      } catch (e) {
        if (!isAdmin) {
          try {
            ledger.refund(accountId, chargedPoints, { sessionId, paragraphId: body.paragraphId, reason: "chat_failed" });
          } catch { /* 退款失败不阻塞 */ }
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (/Missing DASHSCOPE_API_KEY/i.test(msg)) {
          throw new HttpError(400, "MISSING_DASHSCOPE_API_KEY", "未配置 DASHSCOPE_API_KEY");
        }
        throw e;
      }

      const now = Date.now();
      const userMsg = {
        id: randomUUID(),
        role: "user" as const,
        paragraphId: body.paragraphId,
        content: body.message,
        timestamp: now,
      };
      const assistantMsg = {
        id: randomUUID(),
        role: "assistant" as const,
        paragraphId: body.paragraphId,
        content: result.reply,
        revisedText: result.revisedText,
        chargedPoints,
        timestamp: now + 1,
      };

      const chatMessages = [...(session.chatMessages ?? []), userMsg, assistantMsg];
      params.store.update(sessionId, { chatMessages });

      log.info("Chat rewrite completed", { sessionId, paragraphId: body.paragraphId, chargedPoints });

      res.json({
        ok: true,
        userMsg,
        assistantMsg,
        billing: { accountId, balance: ledger.getBalance(accountId) },
      });
    })
  );

  // ────────────────────────────────────────────────────
  // 聊天式改写：应用 AI 建议到文档
  // ────────────────────────────────────────────────────
  router.post(
    "/chat/:sessionId/apply",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");

      const bodySchema = z.object({
        messageId: z.string().min(1),
        editedText: z.string().optional(),
      });
      const body = bodySchema.parse(req.body);

      const msg = (session.chatMessages ?? []).find((m) => m.id === body.messageId);
      if (!msg) throw new HttpError(404, "MESSAGE_NOT_FOUND", "找不到该消息");
      if (msg.role !== "assistant" || !msg.revisedText) {
        throw new HttpError(400, "NOT_APPLICABLE", "该消息没有可应用的改写建议");
      }

      // 优先使用用户手动编辑后的文本，否则使用 AI 生成的原始改写
      const textToApply = body.editedText?.trim() || msg.revisedText;
      const updated = { ...(session.revised ?? {}), [msg.paragraphId]: textToApply };
      const revision = (session.revision ?? 0) + 1;

      const mergedParagraphs = (session.paragraphs ?? []).map((p) => ({
        id: p.id,
        index: p.index,
        kind: p.kind,
        text: updated[p.id] ?? p.text,
      }));
      const reportAfter = detectAigcRisk(mergedParagraphs);

      params.store.update(sessionId, {
        revised: updated,
        reportAfter,
        revision,
        revisedDocx: undefined,
        revisedDocxRevision: undefined,
      });

      res.json({
        ok: true,
        sessionId,
        paragraphId: msg.paragraphId,
        reportAfter,
        exportUrl: `/api/export/${encodeURIComponent(sessionId)}`,
      });
    })
  );

  // ══════════════════════════════════════════════════════
  // 管理员 API
  // ══════════════════════════════════════════════════════

  /** 验证管理员密钥 */
  router.post(
    "/admin/verify",
    asyncHandler(async (req, res) => {
      const body = z.object({ secret: z.string().min(1) }).parse(req.body);
      if (!verifyAdminSecret(body.secret)) {
        throw new HttpError(403, "INVALID_SECRET", "管理员密钥错误");
      }
      res.json({ ok: true });
    })
  );

  /** 获取所有账号列表（需管理员密钥） */
  router.get(
    "/admin/accounts",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req.header("x-admin-secret"))) {
        throw new HttpError(403, "FORBIDDEN", "需要管理员权限");
      }
      const accounts = listAllAccounts();
      res.json({ ok: true, accounts });
    })
  );

  /** 管理员为指定账号充值 */
  router.post(
    "/admin/topup",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req.header("x-admin-secret"))) {
        throw new HttpError(403, "FORBIDDEN", "需要管理员权限");
      }
      const body = z.object({
        accountId: z.string().min(1),
        points: z.number().int().min(1).max(1000000),
      }).parse(req.body);

      ledger.ensureAccount(body.accountId, 0);
      const tx = ledger.topup(body.accountId, body.points, { source: "admin" });
      res.json({
        ok: true,
        accountId: body.accountId,
        balance: ledger.getBalance(body.accountId),
        tx,
      });
    })
  );

  return router;
}

function estimateRewritePoints(text: string): number {
  const len = (text ?? "").trim().length;
  if (!len) return 1;
  return Math.max(1, Math.ceil(len / 200));
}

/**
 * multer 在某些环境下将 UTF-8 文件名按 Latin-1 存入 originalname，
 * 导致中文显示为乱码。此函数尝试将 Latin-1 字节重新解码为 UTF-8。
 */
function decodeMulterFilename(raw: string): string {
  try {
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded;
  } catch {
    return raw;
  }
}

