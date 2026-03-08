import type { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { HttpError } from "../../errors.js";
import {
  auditLog,
  getDefaultFreePoints,
  isAdminRequest,
  ledger,
  listAllAccounts,
  redeemStore,
  verifyAdminSecret,
} from "../../../billing/index.js";
import { adminActionLimiter, adminLoginLimiter } from "../../rateLimit.js";
import { buildUsageReport } from "../../../billing/usageReport.js";

export function registerAdminRoutes(params: { router: Router }) {
  const router = params.router;

  // ══════════════════════════════════════════════════════
  // 管理员 API（所有端点均带限流 + 操作审计）
  // ══════════════════════════════════════════════════════

  /**
   * 验证管理员密钥。
   * 使用 adminLoginLimiter：每 IP 每 15 分钟最多 10 次尝试，防暴力破解。
   */
  router.post(
    "/admin/verify",
    adminLoginLimiter,
    asyncHandler(async (req, res) => {
      const clientIp = req.headers["x-forwarded-for"]
        ? String(req.headers["x-forwarded-for"]).split(",")[0].trim()
        : (req.socket.remoteAddress ?? "unknown");

      const body = z.object({ secret: z.string().min(1) }).parse(req.body);
      if (!verifyAdminSecret(body.secret)) {
        auditLog.record(clientIp, "ADMIN_LOGIN_FAILED", {});
        throw new HttpError(403, "INVALID_SECRET", "管理员密钥错误");
      }

      auditLog.record(clientIp, "ADMIN_LOGIN_SUCCESS", {});
      res.json({ ok: true });
    })
  );

  /** 获取所有账号列表（需管理员密钥） */
  router.get(
    "/admin/accounts",
    adminActionLimiter,
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req.header("x-admin-secret"))) {
        throw new HttpError(403, "FORBIDDEN", "需要管理员权限");
      }
      const accounts = listAllAccounts();
      res.json({ ok: true, accounts });
    })
  );

  /** 管理员为指定账号充值（记录审计日志） */
  router.post(
    "/admin/topup",
    adminActionLimiter,
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req.header("x-admin-secret"))) {
        throw new HttpError(403, "FORBIDDEN", "需要管理员权限");
      }
      const clientIp = req.headers["x-forwarded-for"]
        ? String(req.headers["x-forwarded-for"]).split(",")[0].trim()
        : (req.socket.remoteAddress ?? "unknown");

      const body = z
        .object({
          accountId: z.string().min(1),
          points: z.number().int().min(1).max(1000000),
        })
        .parse(req.body);

      ledger.ensureAccount(body.accountId, 0);
      const tx = ledger.topup(body.accountId, body.points, { source: "admin" });

      auditLog.record(clientIp, "ADMIN_TOPUP", {
        accountId: body.accountId,
        points: body.points,
        newBalance: ledger.getBalance(body.accountId),
        txId: tx.txId,
      });

      res.json({
        ok: true,
        accountId: body.accountId,
        balance: ledger.getBalance(body.accountId),
        tx,
      });
    })
  );

  /**
   * 管理员批量生成兑换码（记录审计日志）。
   * 生成后通过小红书私信等渠道发给付款用户。
   */
  router.post(
    "/admin/generate-codes",
    adminActionLimiter,
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req.header("x-admin-secret"))) {
        throw new HttpError(403, "FORBIDDEN", "需要管理员权限");
      }
      const clientIp = req.headers["x-forwarded-for"]
        ? String(req.headers["x-forwarded-for"]).split(",")[0].trim()
        : (req.socket.remoteAddress ?? "unknown");

      const body = z
        .object({
          packageName: z.string().min(1).max(50),
          points: z.number().int().min(1).max(1000000),
          count: z.number().int().min(1).max(200),
        })
        .parse(req.body);

      const codes = redeemStore.generate(body.packageName, body.points, body.count);

      auditLog.record(clientIp, "GENERATE_CODES", {
        packageName: body.packageName,
        points: body.points,
        count: codes.length,
      });

      res.json({
        ok: true,
        generated: codes.length,
        codes: codes.map((c) => c.code),
        stats: redeemStore.stats(),
      });
    })
  );

  /** 管理员查看所有兑换码及核销状态 */
  router.get(
    "/admin/codes",
    adminActionLimiter,
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req.header("x-admin-secret"))) {
        throw new HttpError(403, "FORBIDDEN", "需要管理员权限");
      }
      const allCodes = redeemStore.listAll();
      const stats = redeemStore.stats();
      res.json({ ok: true, stats, codes: allCodes });
    })
  );

  /**
   * 管理员查看操作审计日志。
   * 记录了所有登录尝试、充值、生成码等操作，含 IP 和时间戳。
   */
  router.get(
    "/admin/audit",
    adminActionLimiter,
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req.header("x-admin-secret"))) {
        throw new HttpError(403, "FORBIDDEN", "需要管理员权限");
      }
      const limit = Math.min(200, Number(req.query["limit"] ?? "100"));
      const entries = auditLog.list(limit);
      const stats = auditLog.actionStats();
      res.json({ ok: true, stats, entries });
    })
  );

  /**
   * token/积分核算报表（管理员）。
   *
   * 设计原因：
   * - 需要用真实 usage 数据判断收费是否要调整；
   * - 输出包含：总 tokens、净扣积分、tokens/积分、按类型拆分（rewrite/auto/chat）。
   */
  router.get(
    "/admin/usage-report",
    adminActionLimiter,
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req.header("x-admin-secret"))) {
        throw new HttpError(403, "FORBIDDEN", "需要管理员权限");
      }
      const rangeDays = Math.min(365, Math.max(1, Number(req.query["days"] ?? "7")));
      const txs = ledger.listAllTransactions(200000);
      const report = buildUsageReport({ txs, rangeDays });
      res.json({ ok: true, report });
    })
  );

  // 预留：管理员可直接设置默认赠送积分（当前不开放接口，避免误操作）
  void getDefaultFreePoints;
}

