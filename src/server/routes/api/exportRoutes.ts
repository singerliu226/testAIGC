import type { Router } from "express";
import type { SessionStore } from "../../sessionStore.js";
import { asyncHandler } from "../asyncHandler.js";
import { HttpError } from "../../errors.js";
import { patchDocxParagraphs } from "../../../docx/patcher.js";

export function registerExportRoutes(params: { router: Router; store: SessionStore }) {
  const router = params.router;

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
        ? session.filename.replace(/\.docx$/i, "") + "-revised.docx"
        : session.filename;

      // 下载文件禁用缓存，避免浏览器复用旧版本导致“下载后再检测分数不变”的错觉
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(outName)}`);
      res.send(buf);
    })
  );
}

