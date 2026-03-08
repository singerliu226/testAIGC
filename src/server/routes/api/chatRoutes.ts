import type { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AppLogger } from "../../../logger/index.js";
import type { SessionStore } from "../../sessionStore.js";
import { asyncHandler } from "../asyncHandler.js";
import { HttpError } from "../../errors.js";
import {
  getAccountIdFromRequestHeader,
  getDefaultFreePoints,
  isAdminRequest,
  ledger,
} from "../../../billing/index.js";
import { chatRewrite } from "../../../llm/chatRewriter.js";
import { detectAigcRisk } from "../../../analysis/detector.js";
import { calcFinalChargePoints, estimatePrechargePoints, loadBillingConfigFromEnv } from "../../../billing/pricing.js";

export function registerChatRoutes(params: { router: Router; logger: AppLogger; store: SessionStore }) {
  const router = params.router;

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
      const report = (session.reportAfter ?? session.reportBefore) as any;
      const pr = (report.paragraphReports ?? []).find(
        (x: { paragraphId: string }) => x.paragraphId === body.paragraphId
      );
      const signals = Array.isArray(pr?.signals) ? pr.signals : [];

      const existing = (session.chatMessages ?? []).filter((m) => m.paragraphId === body.paragraphId);
      const history = existing.map((m) => ({ role: m.role, content: m.content }));

      const cfg = loadBillingConfigFromEnv();
      const callId = randomUUID();
      const prechargePoints = estimatePrechargePoints({ text: p.text, cfg });
      if (!isAdmin) {
        try {
          ledger.charge(accountId, prechargePoints, {
            billing: "llm",
            callId,
            type: "chat",
            sessionId,
            paragraphId: body.paragraphId,
            pointsEstimated: prechargePoints,
            billingMode: cfg.mode,
          });
        } catch (e) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((e as any)?.code === "INSUFFICIENT_POINTS") {
            throw new HttpError(402, "INSUFFICIENT_POINTS", "积分不足：请联系管理员充值");
          }
          throw e;
        }
      }

      let result: { reply: string; revisedText: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } };
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
            ledger.refund(accountId, prechargePoints, {
              billing: "llm",
              callId,
              type: "chat",
              sessionId,
              paragraphId: body.paragraphId,
              reason: "chat_failed",
              pointsEstimated: prechargePoints,
            });
          } catch {
            /* 退款失败不阻塞 */
          }
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (/Missing DASHSCOPE_API_KEY/i.test(msg)) {
          throw new HttpError(400, "MISSING_DASHSCOPE_API_KEY", "未配置 DASHSCOPE_API_KEY");
        }
        throw e;
      }

      const finalPoints = calcFinalChargePoints({ text: result.revisedText, usage: result.usage, cfg });
      const settle = finalPoints - prechargePoints;
      if (!isAdmin && settle !== 0) {
        if (settle > 0) {
          try {
            ledger.charge(accountId, settle, {
              billing: "llm",
              callId,
              type: "chat",
              sessionId,
              paragraphId: body.paragraphId,
              pointsExtra: settle,
              pointsFinal: finalPoints,
              usage: result.usage,
              billingMode: cfg.mode,
            });
          } catch {
            try {
              ledger.refund(accountId, prechargePoints, {
                billing: "llm",
                callId,
                type: "chat",
                sessionId,
                paragraphId: body.paragraphId,
                reason: "settle_insufficient",
                pointsEstimated: prechargePoints,
              });
            } catch {}
            throw new HttpError(402, "INSUFFICIENT_POINTS", "积分不足：请联系管理员充值");
          }
        } else {
          try {
            ledger.refund(accountId, Math.abs(settle), {
              billing: "llm",
              callId,
              type: "chat",
              sessionId,
              paragraphId: body.paragraphId,
              pointsRefund: Math.abs(settle),
              pointsFinal: finalPoints,
              usage: result.usage,
              billingMode: cfg.mode,
            });
          } catch {}
        }
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
        chargedPoints: finalPoints,
        timestamp: now + 1,
      };

      const chatMessages = [...(session.chatMessages ?? []), userMsg, assistantMsg];
      params.store.update(sessionId, { chatMessages });

      log.info("Chat rewrite completed", { sessionId, paragraphId: body.paragraphId, chargedPoints: finalPoints });

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
}

