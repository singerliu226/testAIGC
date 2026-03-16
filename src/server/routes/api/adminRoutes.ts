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
import type { SessionStore } from "../../sessionStore.js";

export function registerAdminRoutes(params: { router: Router; store: SessionStore }) {
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

  /**
   * 管理员活跃看板：实时返回正在运行的改写任务、上传统计和系统内存。
   *
   * 设计原因：
   * - 单节点服务瓶颈是 Dashscope API 并发（每 job 5 并发），管理员需要感知当前负载；
   * - 扫描所有 session 只读 state.json，不加载 docx Buffer，内存安全；
   * - 前端每 10s 轮询，无需 WebSocket。
   */
  router.get(
    "/admin/activity",
    adminActionLimiter,
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req.header("x-admin-secret"))) {
        throw new HttpError(403, "FORBIDDEN", "需要管理员权限");
      }

      const now = Date.now();
      const since24h = now - 24 * 60 * 60 * 1000;
      const since1h = now - 60 * 60 * 1000;

      // 扫描所有 session（24h 内）
      const allSessions = params.store.listAllForAdmin({ sinceMs: since24h });

      // 全量扫描（用于 running job + 历史改写记录）
      const allForJobs = params.store.listAllForAdmin();

      // ── 正在运行的 job ──
      const runningJobs = allForJobs
        .filter((s) => s.autoRewriteJob?.status === "running")
        .map((s) => ({
          sessionId: s.sessionId,
          jobId: s.autoRewriteJob?.jobId ?? null,
          accountIdShort: s.accountId.slice(0, 8) + "…",
          filename: s.filename,
          jobProgress: s.autoRewriteJob?.progress ?? null,
          startedAt: s.autoRewriteJob?.createdAt ?? s.createdAt,
          elapsedMs: now - (s.autoRewriteJob?.createdAt ?? s.createdAt),
        }));

      // ── 24h 内已完成的改写任务（按完成时间降序，最多 30 条）──
      const completedJobs = allSessions
        .filter(
          (s) =>
            s.autoRewriteJob?.status === "completed" &&
            (s.autoRewriteJob.finishedAt ?? 0) >= since24h
        )
        .sort(
          (a, b) =>
            (b.autoRewriteJob?.finishedAt ?? 0) - (a.autoRewriteJob?.finishedAt ?? 0)
        )
        .slice(0, 30)
        .map((s) => {
          const job = s.autoRewriteJob!;
          const p = job.progress ?? {};
          const durationMs =
            job.finishedAt && job.createdAt ? job.finishedAt - job.createdAt : null;
          return {
            sessionId: s.sessionId,
            accountIdShort: s.accountId.slice(0, 8) + "…",
            filename: s.filename,
            finishedAt: job.finishedAt ?? null,
            durationMs,
            scoreBefore: typeof p.overallBefore === "number" ? Math.round(p.overallBefore) : null,
            scoreAfter:
              typeof p.overallCurrent === "number" ? Math.round(p.overallCurrent) : null,
            roundsUsed: p.roundsUsed ?? 0,
            processed: p.processed ?? 0,
            succeeded: p.succeeded ?? 0,
            failed: p.failed ?? 0,
          };
        });

      // ── 24h 内改写汇总统计 ──
      const completedLast24h = allSessions.filter(
        (s) =>
          s.autoRewriteJob?.status === "completed" &&
          (s.autoRewriteJob.finishedAt ?? 0) >= since24h
      ).length;
      const paragraphsRewrittenLast24h = allSessions
        .filter(
          (s) =>
            s.autoRewriteJob?.status === "completed" &&
            (s.autoRewriteJob.finishedAt ?? 0) >= since24h
        )
        .reduce((sum, s) => sum + (s.autoRewriteJob?.progress?.succeeded ?? 0), 0);

      const uploadsLast1h = allSessions.filter((s) => s.createdAt >= since1h).length;
      const uploadsLast24h = allSessions.length;

      // Node.js 进程内存
      const mem = process.memoryUsage();
      const toMB = (b: number) => Math.round(b / 1024 / 1024);

      // 负载判断：以正在运行的 job 数为依据
      const jobCount = runningJobs.length;
      const currentLoad = jobCount <= 5 ? "low" : jobCount <= 10 ? "medium" : "high";

      res.json({
        ok: true,
        snapshot: {
          runningJobCount: jobCount,
          runningJobs,
          completedLast24h,
          paragraphsRewrittenLast24h,
          completedJobs,
          uploadsLast1h,
          uploadsLast24h,
          totalSessions: allForJobs.length,
          memory: {
            heapUsedMB: toMB(mem.heapUsed),
            heapTotalMB: toMB(mem.heapTotal),
            rssMB: toMB(mem.rss),
          },
          capacityHint: {
            safeJobConcurrency: 8,
            maxJobConcurrency: 12,
            currentLoad,
          },
          snapshotAt: now,
        },
      });
    })
  );

  /**
   * 管理员强制取消某个正在运行的改写任务。
   *
   * 设计原因：
   * - 普通用户取消接口需要 sessionId + jobId，管理员只需要 sessionId 即可强制停止；
   * - 用于处理长时间卡住（如 Zeabur 反向代理拦截 AbortController 信号）的任务。
   */
  router.post(
    "/admin/cancel-job/:sessionId",
    adminActionLimiter,
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req.header("x-admin-secret"))) {
        throw new HttpError(403, "FORBIDDEN", "需要管理员权限");
      }
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) {
        throw new HttpError(404, "NOT_FOUND", `Session 不存在: ${sessionId}`);
      }
      const job = session.autoRewriteJob;
      if (!job || job.status !== "running") {
        res.json({ ok: false, message: `该 session 没有正在运行的任务（当前状态: ${job?.status ?? "无任务"}）` });
        return;
      }
      params.store.update(sessionId, {
        autoRewriteJob: {
          ...job,
          status: "cancelled",
          updatedAt: Date.now(),
          finishedAt: Date.now(),
          progress: { ...job.progress, lastMessage: "管理员强制结束" },
        },
      });
      params.store.get(sessionId); // no-op, just for context
      console.warn("[admin] force-cancelled job", { sessionId, jobId: job.jobId });
      res.json({ ok: true, sessionId, jobId: job.jobId, message: "任务已强制结束" });
    })
  );
}

