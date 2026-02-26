import type { Request, Response, NextFunction } from "express";
import type { AppLogger } from "../logger/index.js";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * 统一错误响应（JSON）。
 *
 * 设计原因：
 * - 前端需要稳定的错误结构来展示提示；
 * - 日志需要完整堆栈以便定位问题，但不能把敏感原文回传到浏览器。
 */
export function errorHandler(baseLogger: AppLogger) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const log = req.log ?? baseLogger;

    const httpErr = normalizeToHttpError(err);

    const details =
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : { err };

    log.error("Request failed: %s", httpErr.message, {
      status: httpErr.status,
      code: httpErr.code,
      path: req.path,
      method: req.method,
      ...details,
    });

    res.status(httpErr.status).json({
      ok: false,
      error: {
        code: httpErr.code,
        message: httpErr.message,
        requestId: req.ctx?.requestId,
      },
    });
  };
}

function normalizeToHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;

  // multer 文件过大等错误（避免前端只看到 500）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = err as any;
  if (anyErr && (anyErr.name === "MulterError" || anyErr.code === "LIMIT_FILE_SIZE")) {
    const maxMb = Number(process.env.MAX_UPLOAD_MB ?? "20");
    return new HttpError(413, "UPLOAD_TOO_LARGE", `上传文件过大：最大允许 ${maxMb}MB`);
  }

  // zod 参数校验错误
  if (anyErr && anyErr.name === "ZodError") {
    return new HttpError(400, "INVALID_REQUEST", "请求参数不合法");
  }

  return new HttpError(500, "INTERNAL_ERROR", "服务内部错误");
}

