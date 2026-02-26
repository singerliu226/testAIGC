import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * 让 Express 路由可直接使用 async/await，并把异常交给统一错误处理中间件。
 *
 * 设计原因：
 * - 解析 docx / 调用模型都是异步；
 * - 直接在路由里 try/catch 容易漏掉，统一包一层更可靠。
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

