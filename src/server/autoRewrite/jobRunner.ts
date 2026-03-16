import type { AppLogger } from "../../logger/index.js";
import type { SessionStore } from "../sessionStore.js";
import { detectAigcRisk } from "../../analysis/detector.js";
import type { HttpError } from "../errors.js";
import { rewriteOneInternal, type RewriteOneInternalDeps } from "./rewriteOneInternal.js";

export type AutoRewriteParams = {
  targetScore: number;
  maxRounds: number;
  perRound: number;
  maxTotal: number;
  minParagraphScore: number;
  maxPerParagraph: number;
  stopNoImproveRounds: number;
  allowFactRisk?: boolean;
  preferParagraphIds?: string[];
};

/**
 * 后台运行自动降分任务，并把进度写回 session.autoRewriteJob。
 *
 * 设计原因：
 * - 让前端能轮询看到"真实进度"，避免卡在 90% 假进度；
 * - 即使页面刷新，任务状态仍保留在会话中（disk store）。
 * - 并发批处理（每批 BATCH_SIZE 段）大幅提升吞吐量，避免顺序处理时每段 30-60s 导致的超长等待。
 */
export async function runAutoRewriteJob(params: {
  store: SessionStore;
  logger: AppLogger;
  sessionId: string;
  accountId: string;
  isAdmin: boolean;
  jobId: string;
  body: AutoRewriteParams;
  deps: RewriteOneInternalDeps;
}) {
  const log = params.logger;
  const session = params.store.get(params.sessionId);
  if (!session || !session.paragraphs?.length) return;

  const paragraphs = session.paragraphs;
  const updated: Record<string, string> = { ...(session.revised ?? {}) };
  const rewriteResults: NonNullable<(typeof session)["rewriteResults"]> = {
    ...(session.rewriteResults ?? {}),
  };
  const failures: Array<{ paragraphId: string; paragraphIndex?: number; code: string; message: string }> = [];

  /**
   * 跨任务的段落累计改写次数（由上次任务传承，本次成功改写后递增并在完成时写回）。
   *
   * 设计原因：
   * - 防止同一顽固段落被无限次尝试，每次都消耗积分却无实质效果；
   * - 超过阈值后系统自动跳过该段，并在前端预检弹窗中提示"建议手动处理"。
   */
  const rwCounts: Record<string, number> = { ...(session.paragraphRewriteCounts ?? {}) };
  /**
   * 单段最多累计改写次数（跨多次任务的总计）。
   *
   * 设计原因：
   * - 原值为 3，导致用户仅运行 2-3 轮后所有段落就被锁定，再次点击"一键自动降重"时
   *   立即显示"完成"但什么都没做，造成"1 秒 100%"的错觉。
   * - 调整为 10，允许用户在 AI 率仍较高时继续多轮改写，同时保留上限防止无限循环。
   */
  const MAX_CUMULATIVE_REWRITES = 10;

  const now = Date.now();
  const overallBefore = detectAigcRisk(mergeParagraphs(paragraphs, updated)).overallRiskScore ?? 0;
  params.store.update(params.sessionId, {
    autoRewriteJob: {
      jobId: params.jobId,
      status: "running",
      createdAt: session.autoRewriteJob?.createdAt ?? now,
      updatedAt: now,
      params: params.body,
      progress: {
        roundsUsed: 0,
        processed: 0,
        maxTotal: params.body.maxTotal,
        overallBefore,
        overallCurrent: overallBefore,
        lastMessage: "任务启动",
      },
    },
  });

  let attempted = 0;
  let succeeded = 0;
  let roundsUsed = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let noImproveRounds = 0;
  let jobTimedOut = false; // 全局超时标志，供内外两层循环共享
  const perPidAttempts = new Map<string, number>();

  /**
   * 每批并发改写的段落数。
   *
   * 设计原因：
   * - 原值为 5，在 Zeabur 生产环境下每段最多 3 次串行 LLM 调用 × 60s 超时 = 3 分钟/批，
   *   60 段 / 5 并发 = 12 批 × 3 分钟 = 最坏 36 分钟，且 Zeabur 反向代理有时会吃掉 AbortController 信号；
   * - 降低到 3 后，每批并发 DashScope 压力减少，API 限流概率降低，响应速度更稳定。
   */
  const BATCH_SIZE = 3;

  /**
   * 单段改写最长等待时间（ms）。
   *
   * 设计原因：
   * - rewriteOneInternal 最多发出 3 次串行 LLM 调用，每次 LLM_TIMEOUT_MS=60s；
   * - 在 Zeabur 生产环境，反向代理偶尔会让 AbortController 失效，导致段落无限挂起；
   * - 设置 90s 超时后，Promise.race 会强制解除挂起的段落，将其标记为失败并继续处理其它段落。
   */
  const SEGMENT_TIMEOUT_MS = 90_000;

  /** 整个 job 的最长运行时间（ms）。超过后自动收尾，避免长期占用服务器资源。 */
  const JOB_MAX_DURATION_MS = 25 * 60 * 1000; // 25 分钟
  const jobStartedAt = Date.now();

  try {
    while (roundsUsed < params.body.maxRounds && attempted < params.body.maxTotal && !jobTimedOut) {
      // 检查取消
      const s0 = params.store.get(params.sessionId);
      if (!s0?.autoRewriteJob || s0.autoRewriteJob.jobId !== params.jobId) return;
      if (s0.autoRewriteJob.status === "cancelled") return;

      const curReport = detectAigcRisk(mergeParagraphs(paragraphs, updated));
      const overall = curReport.overallRiskScore ?? 0;

      // 更新 overall
      params.store.update(params.sessionId, {
        autoRewriteJob: {
          ...s0.autoRewriteJob,
          updatedAt: Date.now(),
          progress: {
            ...s0.autoRewriteJob.progress,
            roundsUsed,
            processed: attempted,
            succeeded,
            failed: failures.length,
            overallCurrent: overall,
            lastMessage: `正在筛选第 ${roundsUsed + 1} 轮候选段落…`,
          },
        },
      });

      if (overall <= params.body.targetScore) {
        bestScore = overall;
        break;
      }

      /**
       * 候选段落排序策略：按"字符权重贡献"（riskScore × textLength）降序。
       *
       * 设计原因：
       * - overallRiskScore = Σ(charLen × riskScore/100) / totalCharCount
       * - 仅按 riskScore 排序会优先处理"风险高但字数少"的段落，对总分影响极小；
       * - 按 riskScore × textLength 排序可优先攻打"字数多且风险高"的段落，每段改写对总分降幅最大。
       */
      const all = (curReport.paragraphReports ?? [])
        .filter((r) => r.riskScore >= params.body.minParagraphScore)
        // 跳过本任务内已达 maxPerParagraph 次的段落（防止单轮反复尝试同一段）
        .filter((r) => (perPidAttempts.get(r.paragraphId) ?? 0) < params.body.maxPerParagraph)
        // 跳过跨任务累计已达 MAX_CUMULATIVE_REWRITES 次的顽固段落（继续尝试收益极低）
        .filter((r) => (rwCounts[r.paragraphId] ?? 0) < MAX_CUMULATIVE_REWRITES)
        .sort((a, b) => (b.riskScore * b.text.length) - (a.riskScore * a.text.length));

      const preferSet = new Set((params.body.preferParagraphIds ?? []).filter(Boolean));
      const preferred = preferSet.size ? all.filter((r) => preferSet.has(r.paragraphId)) : [];
      const candidates = (preferred.length ? preferred : all).slice(0, params.body.perRound);

      if (!candidates.length) {
        /**
         * 0 候选段落 → 需要告诉用户具体原因，而不是静默完成：
         * 1. AI率已达标（overall ≤ targetScore，上方已处理）
         * 2. 所有高风险段落均已达到单段累计改写上限（MAX_CUMULATIVE_REWRITES）
         * 3. 所有高风险段落均已在本任务内达到 maxPerParagraph 次
         * 通过分析哪个过滤器最先淘汰段落来给出精确提示
         */
        const beforeCumulativeFilter = (curReport.paragraphReports ?? [])
          .filter((r) => r.riskScore >= params.body.minParagraphScore)
          .filter((r) => (perPidAttempts.get(r.paragraphId) ?? 0) < params.body.maxPerParagraph);
        const allHighRisk = (curReport.paragraphReports ?? []).filter((r) => r.riskScore >= params.body.minParagraphScore);

        let reason: string;
        if (allHighRisk.length === 0) {
          reason = `所有段落 AI 风险均低于阈值（${params.body.minParagraphScore}%），无需改写`;
        } else if (beforeCumulativeFilter.length === 0) {
          // 所有高风险段落已在本轮耗尽 maxPerParagraph
          reason = `本轮所有高风险段落（${allHighRisk.length} 段）已达单任务改写上限（${params.body.maxPerParagraph} 次/段），建议重新启动任务继续`;
        } else {
          // 被跨任务累计次数过滤掉
          reason = `所有高风险段落均已累计改写 ${MAX_CUMULATIVE_REWRITES} 次或以上，已达跨任务上限。AI率当前 ${Math.round(overall)}%，可能需要手动调整`;
        }

        params.store.update(params.sessionId, {
          autoRewriteJob: {
            ...s0.autoRewriteJob,
            updatedAt: Date.now(),
            progress: {
              ...s0.autoRewriteJob.progress,
              roundsUsed,
              processed: attempted,
              succeeded,
              failed: failures.length,
              overallCurrent: overall,
              lastMessage: reason,
              // 用 exhaustedReason 方便前端区分"正常完成"与"无候选完成"
              exhaustedReason: reason,
            },
          },
        });
        break;
      }

      roundsUsed += 1;
      log.info("Auto rewrite job round started", {
        sessionId: params.sessionId,
        jobId: params.jobId,
        round: roundsUsed,
        overallBefore: overall,
        candidateCount: candidates.length,
      });

      /**
       * 并发批处理：每批最多 BATCH_SIZE 段并行改写，显著提升吞吐量。
       * 批内使用 Promise.allSettled 保证单段失败不影响整批；
       * 批结束后统一更新进度，避免并发写入 session store 产生竞态。
       */
      for (let bi = 0; bi < candidates.length; bi += BATCH_SIZE) {
        if (attempted >= params.body.maxTotal) break;

        // 全局任务超时保护：防止任务无限期运行占用服务器
        if (Date.now() - jobStartedAt > JOB_MAX_DURATION_MS) {
          log.warn("Auto rewrite job exceeded max duration, stopping early", {
            sessionId: params.sessionId,
            jobId: params.jobId,
            elapsedMs: Date.now() - jobStartedAt,
            attempted,
            succeeded,
          });
          jobTimedOut = true;
          break;
        }

        const sCheck = params.store.get(params.sessionId);
        if (!sCheck?.autoRewriteJob || sCheck.autoRewriteJob.jobId !== params.jobId) return;
        if (sCheck.autoRewriteJob.status === "cancelled") return;

        const batchCandidates = candidates.slice(bi, bi + BATCH_SIZE);
        const validBatch: Array<{ c: (typeof candidates)[0]; p: (typeof paragraphs)[0] }> = [];

        for (const c of batchCandidates) {
          if (attempted + validBatch.length >= params.body.maxTotal) break;
          const p = paragraphs.find((x) => x.id === c.paragraphId);
          if (!p) continue;
          perPidAttempts.set(p.id, (perPidAttempts.get(p.id) ?? 0) + 1);
          validBatch.push({ c, p });
        }

        if (!validBatch.length) continue;

        // 写入批次开始提示
        const sBatch = params.store.get(params.sessionId);
        if (sBatch?.autoRewriteJob && sBatch.autoRewriteJob.jobId === params.jobId) {
          const idxList = validBatch.map((x) => x.p.index + 1).join("、");
          params.store.update(params.sessionId, {
            autoRewriteJob: {
              ...sBatch.autoRewriteJob,
              updatedAt: Date.now(),
              progress: {
                ...sBatch.autoRewriteJob.progress,
                roundsUsed,
                processed: attempted,
                succeeded,
                failed: failures.length,
                lastMessage: `第 ${roundsUsed} 轮：并发改写第 [${idxList}] 段…`,
              },
            },
          });
        }

        // 并发执行本批次
        const batchResults = await Promise.allSettled(
          validBatch.map(async ({ c, p }) => {
            const baseText = updated[p.id] ?? p.text;
            const before = paragraphs[p.index - 1]?.text;
            const after = paragraphs[p.index + 1]?.text;

            /**
             * 单段超时保护：避免某段 LLM 调用在 Zeabur 代理下 AbortController 失效时无限挂起。
             * 90s 已足够 3 次串行 LLM 调用各完成一次（正常响应 10-25s），若仍超时则跳过本段继续。
             */
            const segmentTimeout = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`段落 ${p.index + 1} 改写超时（>90s），已跳过`)), SEGMENT_TIMEOUT_MS)
            );

            const out = await Promise.race([
              rewriteOneInternal({
                deps: params.deps,
                logger: log,
                sessionId: params.sessionId,
                accountId: params.accountId,
                isAdmin: params.isAdmin,
                type: "auto",
                paragraph: p,
                baseText,
                contextBefore: before,
                contextAfter: after,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                signals: (c.signals ?? []) as any,
                riskBefore: c.riskScore,
                allowFactRisk: params.body.allowFactRisk,
              }),
              segmentTimeout,
            ]);
            return { p, out };
          })
        );

        // 汇总本批次结果
        for (const r of batchResults) {
          attempted += 1;
          if (r.status === "fulfilled") {
            const { p, out } = r.value;
            if (out.ok) {
              updated[p.id] = out.revisedText;
              rewriteResults[p.id] = out.rewriteResult;
              // 成功改写后递增该段累计改写次数（写回 session 时一并持久化）
              rwCounts[p.id] = (rwCounts[p.id] ?? 0) + 1;
              succeeded += 1;
            } else {
              failures.push({
                paragraphId: p.id,
                paragraphIndex: p.index,
                code: out.failure.code,
                message: out.failure.message,
              });
            }
          } else {
            // Promise.allSettled 保证不 throw，防御性处理 rejected
            failures.push({
              paragraphId: "unknown",
              code: "BATCH_ERROR",
              message: r.reason instanceof Error ? r.reason.message : String(r.reason),
            });
          }
        }

        // 批次结束后统一更新进度
        const sAfter = params.store.get(params.sessionId);
        if (sAfter?.autoRewriteJob && sAfter.autoRewriteJob.jobId === params.jobId) {
          params.store.update(params.sessionId, {
            autoRewriteJob: {
              ...sAfter.autoRewriteJob,
              updatedAt: Date.now(),
              failures: failures.slice(-40),
              progress: {
                ...sAfter.autoRewriteJob.progress,
                processed: attempted,
                succeeded,
                failed: failures.length,
                lastMessage: `第 ${roundsUsed} 轮：已完成 ${attempted} 段（成功 ${succeeded}，失败 ${failures.length}）`,
              },
            },
          });
        }
      }

      const afterReport = detectAigcRisk(mergeParagraphs(paragraphs, updated));
      const afterScore = afterReport.overallRiskScore ?? 0;

      const remainingCandidates = (afterReport.paragraphReports ?? [])
        .filter((r) => r.riskScore >= params.body.minParagraphScore)
        .filter((r) => (perPidAttempts.get(r.paragraphId) ?? 0) < params.body.maxPerParagraph)
        .filter((r) => (rwCounts[r.paragraphId] ?? 0) < MAX_CUMULATIVE_REWRITES).length;

      if (afterScore < bestScore) {
        noImproveRounds = 0;
        bestScore = afterScore;
      } else {
        noImproveRounds += 1;
      }

      /**
       * 停机策略（优化版）：
       * - 仅当"连续多轮无改进"且"已经没有任何可继续尝试的候选段落"时才提前结束。
       *
       * 设计原因：
       * - 以前会出现"AI率没变就停"，但其实还有很多段落没试到；
       * - 用户目标是"尽可能显著降低"，只要仍有候选可试，就不应过早停止。
       */
      if (noImproveRounds >= params.body.stopNoImproveRounds && remainingCandidates === 0) break;
    }

    const finalReport = detectAigcRisk(mergeParagraphs(paragraphs, updated));
    const revision = (session.revision ?? 0) + 1;
    const doneAt = Date.now();
    const latestSession = params.store.get(params.sessionId);
    params.store.update(params.sessionId, {
      revised: updated,
      rewriteResults,
      reportAfter: finalReport,
      revision,
      // 累计改写次数持久化，下次任务启动时可读取，跳过已多次尝试的顽固段落
      paragraphRewriteCounts: rwCounts,
      revisedDocx: undefined,
      revisedDocxRevision: undefined,
      autoRewriteJob: {
        jobId: params.jobId,
        status: "completed",
        createdAt: latestSession?.autoRewriteJob?.createdAt ?? doneAt,
        updatedAt: doneAt,
        finishedAt: doneAt,
        params: params.body,
        progress: {
          roundsUsed,
          processed: attempted,
          maxTotal: params.body.maxTotal,
          succeeded,
          failed: failures.length,
          overallBefore,
          overallCurrent: finalReport.overallRiskScore ?? 0,
          lastMessage: jobTimedOut
            ? `已运行超 25 分钟，自动收尾（已成功改写 ${succeeded} 段）`
            : failures.length
            ? `完成（有 ${failures.length} 段未能自动改写）`
            : "完成",
        },
        failures: failures.slice(-80),
      },
    });
  } catch (e) {
    const doneAt = Date.now();
    const err = e as unknown as HttpError;
    const latestSession = params.store.get(params.sessionId);
    params.store.update(params.sessionId, {
      autoRewriteJob: {
        jobId: params.jobId,
        status: "failed",
        createdAt: latestSession?.autoRewriteJob?.createdAt ?? doneAt,
        updatedAt: doneAt,
        finishedAt: doneAt,
        params: params.body,
        progress: {
          roundsUsed,
          processed: attempted,
          maxTotal: params.body.maxTotal,
          succeeded,
          failed: failures.length,
          overallBefore,
          overallCurrent: undefined,
          lastMessage: "失败",
        },
        failures: failures.slice(-80),
        error: { code: (err as any)?.code, message: e instanceof Error ? e.message : String(e) },
      },
    });
  }
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
