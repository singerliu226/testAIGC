import type { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import type { SessionStore } from "../../sessionStore.js";
import { HttpError } from "../../errors.js";
import { getAccountIdFromRequestHeader, getDefaultFreePoints, ledger } from "../../../billing/index.js";

export function registerSessionRoutes(params: { router: Router; store: SessionStore }) {
  const router = params.router;

  /**
   * 列出当前账号的历史会话。
   * 通过 accountId 过滤，确保用户只能看到自己上传的文档记录。
   */
  router.get(
    "/sessions",
    asyncHandler(async (req, res) => {
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());
      const limit = Number(req.query.limit ?? "30");
      const xs = params.store.list(
        accountId,
        Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 30
      );
      res.json({ ok: true, sessions: xs });
    })
  );

  /**
   * 获取单个会话详情。
   * 校验 accountId 归属，防止越权访问其他用户的会话数据。
   */
  router.get(
    "/session/:sessionId",
    asyncHandler(async (req, res) => {
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");

      // 防止越权访问：session 必须属于当前请求账号
      if (session.accountId !== accountId) {
        throw new HttpError(403, "SESSION_ACCESS_DENIED", "无权访问该会话");
      }

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
}

