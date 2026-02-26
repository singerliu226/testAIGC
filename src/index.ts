import "dotenv/config";
import { createAppLogger } from "./logger/index.js";
import { createApp } from "./server/app.js";

/**
 * 应用入口。
 *
 * 设计原因：
 * - 入口只负责“装配”（logger、server、配置），业务逻辑全部下沉到模块中，
 *   便于后续把同一套智能体能力复用到 CLI / 批处理。
 */
async function main() {
  const logger = createAppLogger({ serviceName: "aigc-docx-agent" });
  const { app } = createApp({ logger });

  const port = Number(process.env.PORT ?? "8787");
  app.listen(port, () => {
    logger.info("Server started", { port, env: process.env.NODE_ENV ?? "development" });
  });
}

main().catch((err) => {
  // 入口异常通常属于不可恢复错误，直接打印并退出。
  // 日志仍走 Winston 以保持统一格式。
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

