import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { AppLogger } from "../logger/index.js";

export type RequestId = string & { readonly __brand: "RequestId" };

export type RequestContext = {
  requestId: RequestId;
};

declare module "express-serve-static-core" {
  interface Request {
    ctx?: RequestContext;
    log?: AppLogger;
  }
}

/**
 * 注入请求上下文与链路日志。
 *
 * 设计原因：
 * - 我们需要把一次请求涉及的“上传→解析→检测→改写→回写”日志串起来，
 *   否则用户只看到“导出失败”，很难定位是解析/模型/回写哪一步出错。
 *
 * 实现方式：
 * - 每个请求生成 `requestId`（或读取用户传入的 `x-request-id`）。
 * - 在 `req.log` 上挂一个 child logger，自动携带 requestId。
 */
export function requestContextMiddleware(baseLogger: AppLogger) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const requestIdRaw = (req.header("x-request-id") || randomUUID()).trim();
    const requestId = requestIdRaw as RequestId;
    req.ctx = { requestId };
    req.log = baseLogger.child({ requestId });
    next();
  };
}

