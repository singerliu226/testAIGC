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

      // ── SSE streaming: keep connection alive via pings so nginx never times out ──
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no"); // disable nginx response buffering
      res.flushHeaders();

      const sendEvent = (data: Record<string, unknown>) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      const pingInterval = setInterval(() => sendEvent({ type: "ping" }), 5000);
      const cleanup = () => clearInterval(pingInterval);

      const doRefund = () => {
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
          } catch { /* 退款失败不阻塞 */ }
        }
      };

      /**
       * 防止"刷新丢积分"：客户端断开 SSE 连接（刷新/关闭标签页）时，
       * 若 LLM 尚未完成，立即退还预扣积分。
       * 注意：仅当 LLM 还在运行时才退款；若 LLM 已完成则结算已完成，无需退款。
       */
      let llmCompleted = false;
      req.on("close", () => {
        if (!llmCompleted) {
          cleanup();
          doRefund();
          log.warn("SSE client disconnected before LLM completed, pre-charge refunded", {
            sessionId,
            accountId,
            callId,
          });
        }
      });

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
          // chat 请求通过 SSE keepalive 保活，可给 LLM 更长时间响应
          timeoutMs: 90000,
        });
      } catch (e) {
        cleanup();
        doRefund();
        const msg = e instanceof Error ? e.message : String(e);
        const code = /Missing DASHSCOPE_API_KEY/i.test(msg) ? "MISSING_DASHSCOPE_API_KEY" : "LLM_ERROR";
        sendEvent({ ok: false, type: "error", error: { code, message: msg } });
        res.end();
        return;
      }

      // LLM 已成功返回，即使客户端此后断开也不再退款
      llmCompleted = true;
      cleanup(); // stop pings before settling

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
            sendEvent({ ok: false, type: "error", error: { code: "INSUFFICIENT_POINTS", message: "积分不足：请联系管理员充值" } });
            res.end();
            return;
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

      sendEvent({
        ok: true,
        type: "done",
        userMsg,
        assistantMsg,
        billing: { accountId, balance: ledger.getBalance(accountId) },
      });
      res.end();
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

