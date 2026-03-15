import express from "express";
import multer from "multer";
import type { AppLogger } from "../../logger/index.js";
import type { SessionStore } from "../sessionStore.js";
import { registerAdminRoutes } from "./api/adminRoutes.js";
import { registerBaseRoutes } from "./api/baseRoutes.js";
import { registerChatRoutes } from "./api/chatRoutes.js";
import { registerExportRoutes } from "./api/exportRoutes.js";
import { registerRewriteRoutes } from "./api/rewriteRoutes.js";
import { registerSessionRoutes } from "./api/sessionRoutes.js";
import { registerUploadRoutes } from "./api/uploadRoutes.js";

/**
 * API 路由入口：按模块注册各类端点。
 *
 * 设计原因：
 * - 单文件超过 500 行可维护性急剧下降，按路由域拆分模块更利于迭代与排障；
 * - 让“上传/检测/改写/导出/管理员”各自独立，避免改一个功能牵连全局。
 */
export function createApiRouter(params: { logger: AppLogger; store: SessionStore }) {
  const router = express.Router();

  const maxUploadMb = Number(process.env.MAX_UPLOAD_MB ?? "20");
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadMb * 1024 * 1024 },
  });

  registerBaseRoutes({ router, logger: params.logger });
  registerUploadRoutes({ router, logger: params.logger, store: params.store, upload });
  registerSessionRoutes({ router, store: params.store });
  registerRewriteRoutes({ router, logger: params.logger, store: params.store });
  registerExportRoutes({ router, store: params.store });
  registerChatRoutes({ router, logger: params.logger, store: params.store });
  registerAdminRoutes({ router, store: params.store });

  return router;
}

