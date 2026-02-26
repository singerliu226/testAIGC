import winston from "winston";

export type AppLogger = winston.Logger;

/**
 * 创建应用级 Logger（Winston）。
 *
 * 设计原因：
 * - 智能体是“流水线式”的：上传 → 解析 → 检测 → 改写 → 回写 → 导出。要追踪每一步耗时与失败原因，
 *   必须使用结构化日志而不是 `console.log`。
 * - 通过 `requestId/sessionId` 等字段实现一次请求的链路追踪，方便排查“某段落为何被判高风险/改写失败”。
 * 实现方式：
 * - 开发环境：控制台彩色输出 + 关键字段（利于本地调试）。
 * - 生产环境：JSON 结构化输出（便于日志检索与后续接入 ELK 等）。
 */
export function createAppLogger(opts?: { serviceName?: string }): AppLogger {
  const serviceName = opts?.serviceName ?? "aigc-docx-agent";
  const isProd = process.env.NODE_ENV === "production";

  const baseFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.metadata({
      fillExcept: ["message", "level", "timestamp", "service"],
    })
  );

  const consoleFormat = isProd
    ? winston.format.json()
    : winston.format.combine(
        winston.format.colorize(),
        winston.format.printf((info) => {
          const meta = info.metadata && Object.keys(info.metadata).length
            ? ` ${JSON.stringify(info.metadata)}`
            : "";
          return `${info.timestamp} ${info.level} [${serviceName}] ${info.message}${meta}`;
        })
      );

  return winston.createLogger({
    level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
    defaultMeta: { service: serviceName },
    format: baseFormat,
    transports: [new winston.transports.Console({ format: consoleFormat })],
  });
}

