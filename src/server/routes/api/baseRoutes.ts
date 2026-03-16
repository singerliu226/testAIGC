import type { Router } from "express";
import type { AppLogger } from "../../../logger/index.js";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import {
  getAccountIdFromRequestHeader,
  getDefaultFreePoints,
  ledger,
  redeemStore,
  getAccountInfo,
} from "../../../billing/index.js";

export function registerBaseRoutes(params: { router: Router; logger: AppLogger }) {
  const router = params.router;

  router.get("/health", (_req, res) => res.json({ ok: true }));

  /**
   * 账号信息：返回积分余额与文字粘贴检测免费额度剩余量。
   *
   * 设计原因：
   * - 前端在页面初始化时调用一次，让粘贴区实时显示剩余额度，
   *   避免用户等到提交后才发现额度不足。
   * - 只返回当前账号的公开信息，不涉及敏感数据。
   */
  router.get(
    "/account/info",
    asyncHandler(async (req, res) => {
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());
      const info = getAccountInfo(accountId);
      res.json({ ok: true, accountId, ...info });
    })
  );

  /**
   * 前端配置注入：将可安全暴露的环境变量传给前端（不含密钥类信息）。
   * 目的是让联系微信号等运营配置在后台修改即可，无需修改前端 HTML。
   */
  router.get("/config", (_req, res) => {
    res.json({
      ok: true,
      contactWechat: process.env.CONTACT_WECHAT?.trim() || "",
      defaultFreePoints: getDefaultFreePoints(),
    });
  });

  router.get(
    "/billing/balance",
    asyncHandler(async (req, res) => {
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());
      res.json({ ok: true, accountId, balance: ledger.getBalance(accountId) });
    })
  );

  router.get(
    "/billing/transactions",
    asyncHandler(async (req, res) => {
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());
      res.json({ ok: true, accountId, transactions: ledger.listTransactions(accountId, 30) });
    })
  );

  router.post(
    "/billing/topup",
    asyncHandler(async (req, res) => {
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());
      const body = z.object({ points: z.number().int().min(1).max(100000) }).parse(req.body);
      const tx = ledger.topup(accountId, body.points, { source: "manual" });
      res.json({ ok: true, accountId, balance: ledger.getBalance(accountId), tx });
    })
  );

  /**
   * 兑换码核销：用户输入购买的兑换码，自动到账积分。
   * 这是适配小红书等社交渠道"先付款→发码→用户兑换"模式的核心接口。
   */
  router.post(
    "/billing/redeem",
    asyncHandler(async (req, res) => {
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());

      const body = z.object({ code: z.string().min(1).max(20) }).parse(req.body);

      // 核销兑换码（失败时抛出具体错误信息）
      const result = redeemStore.redeem(body.code, accountId);

      // 成功后给账号充值对应积分
      const tx = ledger.topup(accountId, result.points, {
        source: "redeem",
        code: body.code,
        packageName: result.packageName,
      });

      params.logger.info("兑换码核销成功", { accountId, code: body.code, points: result.points });

      res.json({
        ok: true,
        accountId,
        points: result.points,
        packageName: result.packageName,
        balance: ledger.getBalance(accountId),
        tx,
      });
    })
  );
}

