import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppLogger } from "../logger/index.js";
import { requestContextMiddleware } from "./requestContext.js";
import { errorHandler } from "./errors.js";
import { createApiRouter } from "./routes/api.js";
import { InMemorySessionStore } from "./sessionStore.js";
import { DiskSessionStore } from "./sessionStoreDisk.js";

/**
 * 创建 Express 应用。
 *
 * 设计原因：
 * - 用最少的依赖实现“上传/报告/改写/导出”的交互闭环；
 * - 路由与智能体逻辑解耦，后续可替换成 CLI 或桌面端。
 */
export function createApp(params: { logger: AppLogger }) {
  const app = express();
  const store = createSessionStore();

  app.disable("x-powered-by");
  app.use(requestContextMiddleware(params.logger));
  app.use(express.json({ limit: "2mb" }));

  app.use("/api", createApiRouter({ logger: params.logger, store }));

  // 静态页面（极简 UI）
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const webDir = path.resolve(__dirname, "../../web");
  app.use("/", express.static(webDir));

  // 统一错误处理应放在最后
  app.use(errorHandler(params.logger));

  return { app, store };
}

function createSessionStore() {
  const mode = (process.env.SESSION_STORE ?? "disk").toLowerCase();
  if (mode === "memory") return new InMemorySessionStore();

  const dataDir =
    process.env.DATA_DIR?.trim() ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data");
  return new DiskSessionStore({ dataDir });
}

