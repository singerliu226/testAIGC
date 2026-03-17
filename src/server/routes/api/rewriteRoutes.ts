import type { Router } from "express";
import { z } from "zod";
import type { AppLogger } from "../../../logger/index.js";
import type { SessionStore } from "../../sessionStore.js";
import { asyncHandler } from "../asyncHandler.js";
import { HttpError } from "../../errors.js";
import { detectAigcRisk } from "../../../analysis/detector.js";
import { rewriteParagraphWithDashscope } from "../../../llm/rewriter.js";
import { validateRewriteGuard } from "../../../llm/rewriteGuard.js";
import {
  getAccountIdFromRequestHeader,
  getDefaultFreePoints,
  isAdminRequest,
  ledger,
} from "../../../billing/index.js";
import { calcFinalChargePoints, estimatePrechargePoints, loadBillingConfigFromEnv } from "../../../billing/pricing.js";
import { randomUUID } from "node:crypto";
import { runAutoRewriteJob } from "../../autoRewrite/jobRunner.js";

export function registerRewriteRoutes(params: { router: Router; logger: AppLogger; store: SessionStore }) {
  const router = params.router;

  router.post(
    "/rewrite/:sessionId",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");
      if (!session.paragraphs?.length) throw new HttpError(400, "NO_PARAGRAPHS", "该会话没有可改写段落");
      if (!session.reportBefore) throw new HttpError(400, "NO_REPORT", "请先生成检测报告");
      const paragraphs = session.paragraphs;

      const bodySchema = z.object({
        paragraphIds: z.array(z.string()).min(1).max(30),
      });
      const body = bodySchema.parse(req.body);
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      const isAdmin = isAdminRequest(req.header("x-admin-secret"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());

      const updated: Record<string, string> = { ...(session.revised ?? {}) };
      const rewriteResults: NonNullable<(typeof session)["rewriteResults"]> = {
        ...(session.rewriteResults ?? {}),
      };
      const details: Array<{ paragraphId: string; revisedPreview: string; resolvedSignalIds: string[] }> = [];

      // 以“当前文本”计算信号（避免用旧信号改写导致无效）
      const curReport = detectAigcRisk(mergeParagraphs(paragraphs, updated));
      const paraReports = curReport.paragraphReports ?? [];

      for (const pid of body.paragraphIds) {
        const p = paragraphs.find((x) => x.id === pid);
        if (!p) throw new HttpError(400, "INVALID_PARAGRAPH", `段落不存在：${pid}`);
        const pr = paraReports.find((x) => x.paragraphId === pid);
        const signals = Array.isArray(pr?.signals) ? pr.signals : [];

        const baseText = updated[pid] ?? p.text;
        const before = paragraphs[p.index - 1]?.text;
        const after = paragraphs[p.index + 1]?.text;

        const cfg = loadBillingConfigFromEnv();
        const callId = randomUUID();
        const prechargePoints = estimatePrechargePoints({ text: baseText, cfg });
        const riskBefore = typeof pr?.riskScore === "number" ? pr.riskScore : safeParagraphRiskScore(baseText, p);

        if (!isAdmin) {
          try {
            ledger.charge(accountId, prechargePoints, {
              billing: "llm",
              callId,
              type: "rewrite",
              sessionId,
              paragraphId: pid,
              pointsEstimated: prechargePoints,
              billingMode: cfg.mode,
            });
          } catch (e) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((e as any)?.code === "INSUFFICIENT_POINTS") {
              throw new HttpError(402, "INSUFFICIENT_POINTS", "积分不足：请联系管理员充值");
            }
            throw e;
          }
        }

        try {
          const log = req.log ?? params.logger;
          const out = await rewriteOne({
            logger: log,
            sessionId,
            paragraphId: pid,
            originalText: p.text,
            baseText,
            contextBefore: before,
            contextAfter: after,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            signals: signals as any,
            riskBefore,
          });

          updated[pid] = out.revisedText;

          // tokens 计费：按 usage 结算（缺失 usage 时退化为估算）
          const finalPoints = calcFinalChargePoints({
            text: out.revisedText,
            usage: out.quality.usage,
            cfg,
          });
          const settle = finalPoints - prechargePoints;
          if (!isAdmin && settle !== 0) {
            // 补扣/退款差额
            if (settle > 0) {
              try {
                ledger.charge(accountId, settle, {
                  billing: "llm",
                  callId,
                  type: "rewrite",
                  sessionId,
                  paragraphId: pid,
                  pointsExtra: settle,
                  pointsFinal: finalPoints,
                  usage: out.quality.usage,
                  billingMode: cfg.mode,
                });
              } catch (e) {
                // 余额不足：回滚预扣并拒绝返回改写结果
                try {
                  ledger.refund(accountId, prechargePoints, {
                    billing: "llm",
                    callId,
                    type: "rewrite",
                    sessionId,
                    paragraphId: pid,
                    reason: "settle_insufficient",
                    pointsEstimated: prechargePoints,
                  });
                } catch {
                  /* ignore */
                }
                throw new HttpError(402, "INSUFFICIENT_POINTS", "积分不足：请联系管理员充值");
              }
            } else {
              try {
                ledger.refund(accountId, Math.abs(settle), {
                  billing: "llm",
                  callId,
                  type: "rewrite",
                  sessionId,
                  paragraphId: pid,
                  pointsRefund: Math.abs(settle),
                  pointsFinal: finalPoints,
                  usage: out.quality.usage,
                  billingMode: cfg.mode,
                });
              } catch {
                /* ignore */
              }
            }
          }

          rewriteResults[pid] = {
            revisedText: out.revisedText,
            changeRationale: out.changeRationale,
            riskSignalsResolved: out.riskSignalsResolved,
            needHumanCheck: out.needHumanCheck,
            humanFeatures: out.humanFeatures,
            chargedPoints: finalPoints,
            createdAt: Date.now(),
            quality: out.quality,
          };

          details.push({
            paragraphId: pid,
            revisedPreview: out.revisedText.slice(0, 80),
            resolvedSignalIds: out.riskSignalsResolved,
          });
        } catch (e) {
          if (!isAdmin) {
            try {
              ledger.refund(accountId, prechargePoints, {
                billing: "llm",
                callId,
                type: "rewrite",
                sessionId,
                paragraphId: pid,
                reason: "rewrite_failed",
                pointsEstimated: prechargePoints,
              });
            } catch {
              /* 退款失败不阻塞 */
            }
          }
          throw e;
        }
      }

      const revision = (session.revision ?? 0) + 1;
      const reportAfter = detectAigcRisk(mergeParagraphs(paragraphs, updated));

      params.store.update(sessionId, {
        revised: updated,
        rewriteResults,
        reportAfter,
        revision,
        revisedDocx: undefined,
        revisedDocxRevision: undefined,
      });

      res.json({
        ok: true,
        sessionId,
        rewrittenCount: body.paragraphIds.length,
        exportUrl: `/api/export/${encodeURIComponent(sessionId)}`,
        details,
        reportAfter,
        billing: { accountId, balance: ledger.getBalance(accountId) },
      });
    })
  );

  router.post(
    "/recheck/:sessionId",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");
      if (!session.paragraphs?.length) throw new HttpError(400, "NO_PARAGRAPHS", "该会话没有可复检段落");
      if (!session.reportBefore) throw new HttpError(400, "NO_REPORT", "请先生成检测报告");
      const paragraphs = session.paragraphs;

      const updated: Record<string, string> = { ...(session.revised ?? {}) };
      const reportAfter = detectAigcRisk(mergeParagraphs(paragraphs, updated));
      params.store.update(sessionId, { reportAfter });

      res.json({ ok: true, sessionId, reportAfter });
    })
  );

  /**
   * 自动多轮降分：尽量将整体 AI 率降到目标值（默认 15%）。
   * 只处理高风险段落，并且每次改写都受“真实性护栏”约束，避免编造事实。
   */
  router.post(
    "/rewrite-to-target/:sessionId",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");
      if (!session.paragraphs?.length) throw new HttpError(400, "NO_PARAGRAPHS", "该会话没有可改写段落");
      if (!session.reportBefore) throw new HttpError(400, "NO_REPORT", "请先生成检测报告");
      const paragraphs = session.paragraphs;

      const body = z
        .object({
          targetScore: z.number().int().min(0).max(100).optional().default(15),
          maxRounds: z.number().int().min(1).max(12).optional().default(6),
          perRound: z.number().int().min(1).max(20).optional().default(8),
          maxTotal: z.number().int().min(1).max(60).optional().default(30),
          minParagraphScore: z.number().int().min(0).max(100).optional().default(35),
          maxPerParagraph: z.number().int().min(1).max(5).optional().default(2),
          stopNoImproveRounds: z.number().int().min(1).max(5).optional().default(2),
          allowFactRisk: z.boolean().optional().default(false),
          preferParagraphIds: z.array(z.string().min(1)).optional(),
        })
        .parse(req.body ?? {});

      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      const isAdmin = isAdminRequest(req.header("x-admin-secret"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());

      const log = req.log ?? params.logger;
      const updated: Record<string, string> = { ...(session.revised ?? {}) };
      const rewriteResults: NonNullable<(typeof session)["rewriteResults"]> = {
        ...(session.rewriteResults ?? {}),
      };

      let total = 0;
      let roundsUsed = 0;
      let bestScore = Number.POSITIVE_INFINITY;
      let noImproveRounds = 0;

      const perPidAttempts = new Map<string, number>();
      const failures: Array<{ paragraphId: string; code: string; message: string }> = [];

      while (roundsUsed < body.maxRounds && total < body.maxTotal) {
        const curReport = detectAigcRisk(mergeParagraphs(paragraphs, updated));
        const overall = curReport.overallRiskScore ?? 0;

        if (overall <= body.targetScore) {
          bestScore = overall;
          break;
        }

        const candidates = (curReport.paragraphReports ?? [])
          .filter((r) => r.riskScore >= body.minParagraphScore)
          .sort((a, b) => b.riskScore - a.riskScore)
          .filter((r) => (perPidAttempts.get(r.paragraphId) ?? 0) < body.maxPerParagraph)
          .slice(0, body.perRound);

        if (!candidates.length) break;

        roundsUsed += 1;
        log.info("Auto rewrite round started", {
          sessionId,
          round: roundsUsed,
          targetScore: body.targetScore,
          overallBefore: overall,
          candidates: candidates.map((c) => ({ paragraphId: c.paragraphId, riskScore: c.riskScore })),
        });

        for (const c of candidates) {
          if (total >= body.maxTotal) break;
          const p = paragraphs.find((x) => x.id === c.paragraphId);
          if (!p) continue;

          const pid = p.id;
          perPidAttempts.set(pid, (perPidAttempts.get(pid) ?? 0) + 1);

          const baseText = updated[pid] ?? p.text;
          const before = paragraphs[p.index - 1]?.text;
          const after = paragraphs[p.index + 1]?.text;
          const riskBefore = c.riskScore;
          const cfg = loadBillingConfigFromEnv();
          const callId = randomUUID();
          const prechargePoints = estimatePrechargePoints({ text: baseText, cfg });

          if (!isAdmin) {
            try {
              ledger.charge(accountId, prechargePoints, {
                billing: "llm",
                callId,
                type: "auto",
                sessionId,
                paragraphId: pid,
                pointsEstimated: prechargePoints,
                billingMode: cfg.mode,
              });
            } catch (e) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if ((e as any)?.code === "INSUFFICIENT_POINTS") {
                throw new HttpError(402, "INSUFFICIENT_POINTS", "积分不足：请联系管理员充值");
              }
              throw e;
            }
          }

          try {
            const out = await rewriteOne({
              logger: log,
              sessionId,
              paragraphId: pid,
              originalText: p.text,
              baseText,
              contextBefore: before,
              contextAfter: after,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              signals: (c.signals ?? []) as any,
              riskBefore,
            });

            updated[pid] = out.revisedText;
            const finalPoints = calcFinalChargePoints({
              text: out.revisedText,
              usage: out.quality.usage,
              cfg,
            });
            const settle = finalPoints - prechargePoints;
            if (!isAdmin && settle !== 0) {
              if (settle > 0) {
                try {
                  ledger.charge(accountId, settle, {
                    billing: "llm",
                    callId,
                    type: "auto",
                    sessionId,
                    paragraphId: pid,
                    pointsExtra: settle,
                    pointsFinal: finalPoints,
                    usage: out.quality.usage,
                    billingMode: cfg.mode,
                  });
                } catch {
                  try {
                    ledger.refund(accountId, prechargePoints, {
                      billing: "llm",
                      callId,
                      type: "auto",
                      sessionId,
                      paragraphId: pid,
                      reason: "settle_insufficient",
                      pointsEstimated: prechargePoints,
                    });
                  } catch {}
                  throw new HttpError(402, "INSUFFICIENT_POINTS", "积分不足：请联系管理员充值");
                }
              } else {
                try {
                  ledger.refund(accountId, Math.abs(settle), {
                    billing: "llm",
                    callId,
                    type: "auto",
                    sessionId,
                    paragraphId: pid,
                    pointsRefund: Math.abs(settle),
                    pointsFinal: finalPoints,
                    usage: out.quality.usage,
                    billingMode: cfg.mode,
                  });
                } catch {}
              }
            }

            rewriteResults[pid] = {
              revisedText: out.revisedText,
              changeRationale: out.changeRationale,
              riskSignalsResolved: out.riskSignalsResolved,
              needHumanCheck: out.needHumanCheck,
              humanFeatures: out.humanFeatures,
              chargedPoints: finalPoints,
              createdAt: Date.now(),
              quality: out.quality,
            };
            total += 1;
          } catch (e) {
            if (!isAdmin) {
              try {
                ledger.refund(accountId, prechargePoints, {
                  billing: "llm",
                  callId,
                  type: "auto",
                  sessionId,
                  paragraphId: pid,
                  reason: "auto_failed",
                  pointsEstimated: prechargePoints,
                });
              } catch {
                /* ignore */
              }
            }
            const err = e instanceof HttpError ? e : new HttpError(500, "AUTO_REWRITE_FAILED", String(e));
            failures.push({ paragraphId: pid, code: err.code, message: err.message });
          }
        }

        const afterReport = detectAigcRisk(mergeParagraphs(paragraphs, updated));
        const afterScore = afterReport.overallRiskScore ?? 0;

        if (afterScore < bestScore) {
          noImproveRounds = 0;
          bestScore = afterScore;
        } else {
          noImproveRounds += 1;
        }

        log.info("Auto rewrite round completed", {
          sessionId,
          round: roundsUsed,
          overallAfter: afterScore,
          noImproveRounds,
          rewrittenTotal: total,
          failures: failures.length,
        });

        if (noImproveRounds >= body.stopNoImproveRounds) break;
      }

      const revision = (session.revision ?? 0) + 1;
      const reportAfter = detectAigcRisk(mergeParagraphs(paragraphs, updated));
      params.store.update(sessionId, {
        revised: updated,
        rewriteResults,
        reportAfter,
        revision,
        revisedDocx: undefined,
        revisedDocxRevision: undefined,
      });

      res.json({
        ok: true,
        sessionId,
        targetScore: body.targetScore,
        roundsUsed,
        rewrittenCount: total,
        overallAfter: reportAfter.overallRiskScore,
        exportUrl: `/api/export/${encodeURIComponent(sessionId)}`,
        reportAfter,
        failures,
        billing: { accountId, balance: ledger.getBalance(accountId) },
      });
    })
  );

  /**
   * 自动降分（后台任务）：启动
   *
   * 设计原因：
   * - 长任务不能用“伪进度条”；启动后由前端轮询 status 获取真实进度。
   */
  router.post(
    "/rewrite-to-target/:sessionId/start",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");
      if (!session.paragraphs?.length) throw new HttpError(400, "NO_PARAGRAPHS", "该会话没有可改写段落");
      if (!session.reportBefore) throw new HttpError(400, "NO_REPORT", "请先生成检测报告");

      const body = z
        .object({
          targetScore: z.number().int().min(0).max(100).optional().default(15),
          maxRounds: z.number().int().min(1).max(20).optional().default(6),
          perRound: z.number().int().min(1).max(200).optional().default(8),
          maxTotal: z.number().int().min(1).max(500).optional().default(30),
          minParagraphScore: z.number().int().min(0).max(100).optional().default(35),
          maxPerParagraph: z.number().int().min(1).max(5).optional().default(2),
          stopNoImproveRounds: z.number().int().min(1).max(10).optional().default(2),
          allowFactRisk: z.boolean().optional().default(false),
          preferParagraphIds: z.array(z.string()).optional().default([]),
        })
        .parse(req.body ?? {});

      // 若已有运行中的任务，则复用
      if (session.autoRewriteJob && (session.autoRewriteJob.status === "queued" || session.autoRewriteJob.status === "running")) {
        return res.json({
          ok: true,
          sessionId,
          jobId: session.autoRewriteJob.jobId,
          statusUrl: `/api/rewrite-to-target/${encodeURIComponent(sessionId)}/status/${encodeURIComponent(session.autoRewriteJob.jobId)}`,
        });
      }

      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      const isAdmin = isAdminRequest(req.header("x-admin-secret"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());

      // 积分预检：非管理员余额为 0 时立即拦截，避免"60段全部INSUFFICIENT_POINTS失败"
      if (!isAdmin) {
        const balance = ledger.getBalance(accountId);
        const billingCfg = loadBillingConfigFromEnv();
        if (balance < billingCfg.minPointsPerCall) {
          throw new HttpError(
            402,
            "INSUFFICIENT_POINTS",
            `积分不足：当前余额 ${balance} 积分，至少需要 ${billingCfg.minPointsPerCall} 积分才能启动改写任务。请联系管理员充值后重试。`
          );
        }
      }

      const jobId = randomUUID();
      const now = Date.now();
      params.store.update(sessionId, {
        autoRewriteJob: {
          jobId,
          status: "queued",
          createdAt: now,
          updatedAt: now,
          params: body,
          progress: { roundsUsed: 0, processed: 0, maxTotal: body.maxTotal, lastMessage: "排队中…" },
        },
      });

      // 后台异步执行
      void runAutoRewriteJob({
        store: params.store,
        logger: req.log ?? params.logger,
        sessionId,
        accountId,
        isAdmin,
        jobId,
        body,
        deps: {},
      });

      res.json({
        ok: true,
        sessionId,
        jobId,
        statusUrl: `/api/rewrite-to-target/${encodeURIComponent(sessionId)}/status/${encodeURIComponent(jobId)}`,
      });
    })
  );

  /** 自动降分（后台任务）：状态（按 jobId 查询） */
  router.get(
    "/rewrite-to-target/:sessionId/status/:jobId",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const jobId = String(req.params.jobId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");
      const job = session.autoRewriteJob;
      // "current" 是前端用的别名，返回当前任何状态的 job（无需精确匹配 jobId）
      if (jobId === "current") {
        if (!job) throw new HttpError(404, "JOB_NOT_FOUND", "该会话暂无改写任务");
        return res.json({ ok: true, sessionId, jobId: job.jobId, job });
      }
      if (!job || job.jobId !== jobId) throw new HttpError(404, "JOB_NOT_FOUND", "找不到该任务");
      res.json({ ok: true, sessionId, jobId, job });
    })
  );

  /** 自动降分（后台任务）：取消 */
  router.post(
    "/rewrite-to-target/:sessionId/cancel/:jobId",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const jobId = String(req.params.jobId);
      const session = params.store.get(sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "找不到该会话");
      const job = session.autoRewriteJob;
      if (!job || job.jobId !== jobId) throw new HttpError(404, "JOB_NOT_FOUND", "找不到该任务");
      if (job.status === "completed" || job.status === "failed") {
        return res.json({ ok: true, sessionId, jobId, job });
      }
      params.store.update(sessionId, {
        autoRewriteJob: {
          ...job,
          status: "cancelled",
          updatedAt: Date.now(),
          finishedAt: Date.now(),
          progress: { ...job.progress, lastMessage: "已取消" },
        },
      });
      res.json({ ok: true, sessionId, jobId, cancelled: true });
    })
  );
}

type RewriteOneParams = {
  logger: AppLogger;
  sessionId: string;
  paragraphId: string;
  originalText: string;
  baseText: string;
  contextBefore?: string;
  contextAfter?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signals: any[];
  riskBefore: number;
};

async function rewriteOne(params: RewriteOneParams): Promise<{
  revisedText: string;
  changeRationale: string[];
  riskSignalsResolved: string[];
  needHumanCheck: string[];
  humanFeatures?: string[];
  quality: {
    riskBefore: number;
    riskAfter: number;
    similarity: number;
    retryUsed: boolean;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  };
}> {
  const attempt1 = await rewriteParagraphWithDashscope({
    logger: params.logger,
    paragraphText: params.baseText,
    contextBefore: params.contextBefore,
    contextAfter: params.contextAfter,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signals: params.signals as any,
    rewriteMode: "normal",
  });
  const guard1 = validateRewriteGuard({ originalText: params.originalText, revisedText: attempt1.revisedText });
  if (!guard1.ok) {
    params.logger.warn("Rewrite guardrail violated in normal mode", {
      sessionId: params.sessionId,
      paragraphId: params.paragraphId,
      violations: guard1.violations.slice(0, 6),
    });
  }

  const sim1 = bigramJaccardSimilarity(params.originalText, attempt1.revisedText);
  const riskAfter1 = safeParagraphRiskScore(attempt1.revisedText, {
    id: params.paragraphId,
    index: 0,
    kind: "paragraph",
    text: params.originalText,
  });

  let chosen = attempt1;
  let chosenSim = sim1;
  let chosenRiskAfter = riskAfter1;
  let chosenUsage = attempt1.usage;
  let retryUsed = false;

  const needsRetry = !guard1.ok || sim1 >= 0.92 || riskAfter1 >= params.riskBefore - 5;
  if (needsRetry) {
    retryUsed = true;
    const attempt2 = await rewriteParagraphWithDashscope({
      logger: params.logger,
      paragraphText: params.baseText,
      contextBefore: params.contextBefore,
      contextAfter: params.contextAfter,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signals: params.signals as any,
      rewriteMode: "aggressive",
      minChangeRatio: 0.3,
    });
    const guard2 = validateRewriteGuard({ originalText: params.originalText, revisedText: attempt2.revisedText });
    if (!guard2.ok) {
      params.logger.warn("Rewrite guardrail violated in aggressive mode", {
        sessionId: params.sessionId,
        paragraphId: params.paragraphId,
        violations: guard2.violations.slice(0, 6),
      });
    }

    const sim2 = bigramJaccardSimilarity(params.originalText, attempt2.revisedText);
    const riskAfter2 = safeParagraphRiskScore(attempt2.revisedText, {
      id: params.paragraphId,
      index: 0,
      kind: "paragraph",
      text: params.originalText,
    });

    if (guard1.ok && !guard2.ok) {
      chosen = attempt1;
      chosenSim = sim1;
      chosenRiskAfter = riskAfter1;
      chosenUsage = attempt1.usage;
    } else if (!guard1.ok && guard2.ok) {
      chosen = attempt2;
      chosenSim = sim2;
      chosenRiskAfter = riskAfter2;
      chosenUsage = attempt2.usage;
    } else if (!guard1.ok && !guard2.ok) {
      const summary = guard2.violations
        .slice(0, 3)
        .map((v) => `${v.ruleId}:${v.evidence}`)
        .join("；");
      throw new HttpError(
        422,
        "REWRITE_GUARDRAIL",
        `改写被拦截：检测到疑似新增事实锚点（请手动修改或重试）。${summary}`
      );
    } else {
      const better = pickBetterRewrite({
        a: { out: attempt1, similarity: sim1, riskAfter: riskAfter1 },
        b: { out: attempt2, similarity: sim2, riskAfter: riskAfter2 },
      });
      chosen = better.out;
      chosenSim = better.similarity;
      chosenRiskAfter = better.riskAfter;
      chosenUsage = better.out.usage;
    }
  }

  return {
    revisedText: chosen.revisedText,
    changeRationale: Array.isArray(chosen.changeRationale) ? chosen.changeRationale : [],
    riskSignalsResolved: Array.isArray(chosen.riskSignalsResolved) ? chosen.riskSignalsResolved : [],
    needHumanCheck: Array.isArray(chosen.needHumanCheck) ? chosen.needHumanCheck : [],
    humanFeatures: Array.isArray(chosen.humanFeatures) ? chosen.humanFeatures : [],
    quality: {
      riskBefore: params.riskBefore,
      riskAfter: chosenRiskAfter,
      similarity: Number(chosenSim.toFixed(3)),
      retryUsed,
      usage: chosenUsage,
    },
  };
}

function mergeParagraphs(
  paragraphs: Array<{ id: string; index: number; kind: "paragraph" | "tableCellParagraph" | "imageParagraph"; text: string }>,
  revised: Record<string, string>
) {
  return paragraphs.map((p) => ({
    id: p.id,
    index: p.index,
    kind: p.kind,
    text: revised[p.id] ?? p.text,
  }));
}

/**
 * 计算两段文本的相似度（0-1），基于字符 bigram 的 Jaccard。
 *
 * 设计原因：
 * - 需要快速判断“改写是否与原文过于相似”，以决定是否触发强力重试；
 * - bigram 相似度对中文更稳定，不依赖分词库，且对“同义词替换但结构不变”的情况更敏感。
 */
function bigramJaccardSimilarity(aRaw: string, bRaw: string): number {
  const a = normalizeForSimilarity(aRaw);
  const b = normalizeForSimilarity(bRaw);
  if (!a && !b) return 1;
  if (!a || !b) return 0;

  const grams = (s: string) => {
    const set = new Set<string>();
    if (s.length === 1) {
      set.add(s);
      return set;
    }
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };

  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function normalizeForSimilarity(s: string): string {
  return String(s ?? "")
    .replace(/\s+/g, "")
    .replace(/[，。；：、！？“”‘’（）()【】\[\]{}<>《》…—\-·•]/g, "")
    .trim();
}

/**
 * 在不抛异常的前提下获取段落风险分。
 *
 * 设计原因：
 * - 改写质量评估属于“辅助决策”，不应因为极端输入导致整次改写失败；
 * - 出错时返回 0，等同于不触发重试的保守策略。
 */
function safeParagraphRiskScore(
  text: string,
  p: { id: string; index: number; kind: "paragraph" | "tableCellParagraph" | "imageParagraph"; text: string }
): number {
  try {
    const r = detectAigcRisk([{ id: p.id, index: p.index, kind: p.kind, text }]);
    return r.paragraphReports?.[0]?.riskScore ?? 0;
  } catch {
    return 0;
  }
}

function pickBetterRewrite<T extends { revisedText: string }>(params: {
  a: { out: T; similarity: number; riskAfter: number };
  b: { out: T; similarity: number; riskAfter: number };
}) {
  if (params.b.riskAfter < params.a.riskAfter) return params.b;
  if (params.b.riskAfter > params.a.riskAfter) return params.a;
  // 风险分一致时，优先选择更不相似（更可能打破检测特征）
  if (params.b.similarity < params.a.similarity) return params.b;
  return params.a;
}

