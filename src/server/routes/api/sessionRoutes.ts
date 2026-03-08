import type { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import type { SessionStore } from "../../sessionStore.js";
import { HttpError } from "../../errors.js";

export function registerSessionRoutes(params: { router: Router; store: SessionStore }) {
  const router = params.router;

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
}

