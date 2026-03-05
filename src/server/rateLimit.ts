import type { Request, Response, NextFunction } from "express";

/**
 * 内存型 IP 速率限制中间件（无外部依赖）。
 *
 * 设计原因：
 * - 防止管理员密钥被暴力破解：攻击者逐一尝试密码时，IP 连续错误会被临时锁定；
 * - 无需 express-rate-limit 等外部包，减少部署依赖；
 * - 使用滑动窗口计数器（固定窗口近似实现），适合单进程低流量场景。
 *
 * 实现方式：
 * - 每个 IP 维护一个 {count, resetAt} 桶，超过 windowMs 后自动重置；
 * - setInterval 定期清理过期桶，防止内存无限增长。
 */

type Bucket = { count: number; resetAt: number };

/** IP → 计数桶 */
const buckets = new Map<string, Bucket>();

/**
 * 从请求头中提取真实客户端 IP。
 * Zeabur / Nginx 反向代理会在 x-forwarded-for 中携带原始 IP。
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * 创建速率限制中间件工厂。
 *
 * @param windowMs     滑动窗口时长（毫秒）
 * @param maxRequests  窗口内最大请求次数
 * @param message      超限时返回给客户端的错误说明
 */
export function createRateLimiter(params: {
  windowMs: number;
  maxRequests: number;
  message: string;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = getClientIp(req);
    const now = Date.now();

    let bucket = buckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + params.windowMs };
      buckets.set(ip, bucket);
    }

    bucket.count++;

    if (bucket.count > params.maxRequests) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        ok: false,
        error: {
          code: "TOO_MANY_REQUESTS",
          message: params.message,
          retryAfter: retryAfterSec,
        },
      });
      return;
    }

    next();
  };
}

/** 管理员登录端点：每15分钟最多10次尝试，防暴力破解 */
export const adminLoginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  message: "登录尝试次数过多，请 15 分钟后再试",
});

/** 管理员操作端点：每分钟最多60次，防脚本滥用 */
export const adminActionLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: "请求过于频繁，请稍后再试",
});

/** 文件上传端点：每分钟最多30次，防止批量扫描 */
export const uploadLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  message: "上传过于频繁，请稍后再试",
});

// 每5分钟清理过期桶，避免内存无限增长
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}, 5 * 60 * 1000);
