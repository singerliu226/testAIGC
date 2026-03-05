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
 * 安全加固策略：
 * 1. 关闭 x-powered-by，避免暴露框架信息；
 * 2. 注入标准安全响应头（X-Frame-Options / X-Content-Type-Options 等）；
 * 3. 管理员面板路径混淡：设置 ADMIN_PATH_TOKEN 后，/admin.html 返回 404，
 *    只有 /admin-<token>.html 才能访问管理面板，防止路径扫描发现管理入口。
 */
export function createApp(params: { logger: AppLogger }) {
  const app = express();
  const store = createSessionStore();

  // ── 安全响应头（全局） ──
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  app.use(requestContextMiddleware(params.logger));
  app.use(express.json({ limit: "2mb" }));

  app.use("/api", createApiRouter({ logger: params.logger, store }));

  // ── 静态页面 + 管理员面板路径混淡 ──
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const webDir = path.resolve(__dirname, "../../web");

  const adminToken = process.env.ADMIN_PATH_TOKEN?.trim();
  if (adminToken) {
    // 封锁默认路径，返回 404
    app.get("/admin.html", (_req, res) => res.status(404).send("Not Found"));
    // 管理面板仅在含 token 的路径下可访问
    app.get(`/admin-${adminToken}.html`, (_req, res) =>
      res.sendFile(path.join(webDir, "admin.html"))
    );
    params.logger.info("Admin panel path obfuscation enabled", {
      path: `/admin-${adminToken}.html`,
    });
  } else {
    params.logger.warn(
      "ADMIN_PATH_TOKEN not set — admin panel accessible at /admin.html (set it in production)"
    );
  }

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
