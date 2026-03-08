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
 * - 让前端能轮询看到“真实进度”，避免卡在 90% 假进度；
 * - 即使页面刷新，任务状态仍保留在会话中（disk store）。
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

  const now = Date.now();
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
        overallBefore: detectAigcRisk(mergeParagraphs(paragraphs, updated)).overallRiskScore ?? 0,
        overallCurrent: detectAigcRisk(mergeParagraphs(paragraphs, updated)).overallRiskScore ?? 0,
        lastMessage: "任务启动",
      },
    },
  });

  let attempted = 0;
  let succeeded = 0;
  let roundsUsed = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let noImproveRounds = 0;
  const perPidAttempts = new Map<string, number>();

  try {
    while (roundsUsed < params.body.maxRounds && attempted < params.body.maxTotal) {
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

      const all = (curReport.paragraphReports ?? [])
        .filter((r) => r.riskScore >= params.body.minParagraphScore)
        .sort((a, b) => b.riskScore - a.riskScore)
        .filter((r) => (perPidAttempts.get(r.paragraphId) ?? 0) < params.body.maxPerParagraph);

      const preferSet = new Set((params.body.preferParagraphIds ?? []).filter(Boolean));
      const preferred = preferSet.size ? all.filter((r) => preferSet.has(r.paragraphId)) : [];
      const candidates = (preferred.length ? preferred : all).slice(0, params.body.perRound);

      if (!candidates.length) break;

      roundsUsed += 1;
      log.info("Auto rewrite job round started", {
        sessionId: params.sessionId,
        jobId: params.jobId,
        round: roundsUsed,
        overallBefore: overall,
        candidateCount: candidates.length,
      });

      for (const c of candidates) {
        if (attempted >= params.body.maxTotal) break;

        const s1 = params.store.get(params.sessionId);
        if (!s1?.autoRewriteJob || s1.autoRewriteJob.jobId !== params.jobId) return;
        if (s1.autoRewriteJob.status === "cancelled") return;

        const p = paragraphs.find((x) => x.id === c.paragraphId);
        if (!p) continue;
        const pid = p.id;
        perPidAttempts.set(pid, (perPidAttempts.get(pid) ?? 0) + 1);

        // 写入当前处理段落
        params.store.update(params.sessionId, {
          autoRewriteJob: {
            ...s1.autoRewriteJob,
            updatedAt: Date.now(),
            progress: {
              ...s1.autoRewriteJob.progress,
              roundsUsed,
              processed: attempted,
              succeeded,
              failed: failures.length,
              currentParagraphId: pid,
              currentParagraphIndex: p.index,
              lastMessage: `第 ${roundsUsed} 轮：正在改写第 ${p.index + 1} 段…`,
            },
          },
        });

        const baseText = updated[pid] ?? p.text;
        const before = paragraphs[p.index - 1]?.text;
        const after = paragraphs[p.index + 1]?.text;

        // 复用原有“单段改写 + 护栏 + token计费结算”
        const out = await rewriteOneInternal({
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
        });

        if (out.ok) {
          updated[pid] = out.revisedText;
          rewriteResults[pid] = out.rewriteResult;
          attempted += 1;
          succeeded += 1;
          const sOk = params.store.get(params.sessionId);
          if (sOk?.autoRewriteJob && sOk.autoRewriteJob.jobId === params.jobId) {
            params.store.update(params.sessionId, {
              autoRewriteJob: {
                ...sOk.autoRewriteJob,
                updatedAt: Date.now(),
                progress: {
                  ...sOk.autoRewriteJob.progress,
                  processed: attempted,
                  succeeded,
                  failed: failures.length,
                  lastMessage: `第 ${roundsUsed} 轮：已完成第 ${p.index + 1} 段（成功）`,
                },
              },
            });
          }
        } else {
          attempted += 1;
          failures.push({
            paragraphId: pid,
            paragraphIndex: p.index,
            code: out.failure.code,
            message: out.failure.message,
          });
          // 将失败信息也写入 job，保证用户立刻看到“为什么没改”
          const s2 = params.store.get(params.sessionId);
          if (s2?.autoRewriteJob && s2.autoRewriteJob.jobId === params.jobId) {
            params.store.update(params.sessionId, {
              autoRewriteJob: {
                ...s2.autoRewriteJob,
                updatedAt: Date.now(),
                failures: failures.slice(-40),
                progress: {
                  ...s2.autoRewriteJob.progress,
                  processed: attempted,
                  succeeded,
                  failed: failures.length,
                  lastMessage: `第 ${roundsUsed} 轮：第 ${p.index + 1} 段被拦截/失败，已跳过继续…`,
                },
              },
            });
          }
        }
      }

      const afterReport = detectAigcRisk(mergeParagraphs(paragraphs, updated));
      const afterScore = afterReport.overallRiskScore ?? 0;

      const remainingCandidates = (afterReport.paragraphReports ?? [])
        .filter((r) => r.riskScore >= params.body.minParagraphScore)
        .filter((r) => (perPidAttempts.get(r.paragraphId) ?? 0) < params.body.maxPerParagraph).length;

      if (afterScore < bestScore) {
        noImproveRounds = 0;
        bestScore = afterScore;
      } else {
        noImproveRounds += 1;
      }

      /**
       * 停机策略（优化版）：
       * - 仅当“连续多轮无改进”且“已经没有任何可继续尝试的候选段落”时才提前结束。
       *
       * 设计原因：
       * - 以前会出现“AI率没变就停”，但其实还有很多段落没试到；
       * - 用户目标是“尽可能显著降低”，只要仍有候选可试，就不应过早停止。
       */
      if (noImproveRounds >= params.body.stopNoImproveRounds && remainingCandidates === 0) break;
    }

    const finalReport = detectAigcRisk(mergeParagraphs(paragraphs, updated));
    const revision = (session.revision ?? 0) + 1;
    const doneAt = Date.now();
    params.store.update(params.sessionId, {
      revised: updated,
      rewriteResults,
      reportAfter: finalReport,
      revision,
      revisedDocx: undefined,
      revisedDocxRevision: undefined,
      autoRewriteJob: {
        jobId: params.jobId,
        status: "completed",
        createdAt: session.autoRewriteJob?.createdAt ?? doneAt,
        updatedAt: doneAt,
        finishedAt: doneAt,
        params: params.body,
        progress: {
          roundsUsed,
          processed: attempted,
          maxTotal: params.body.maxTotal,
          succeeded,
          failed: failures.length,
          overallBefore: session.autoRewriteJob?.progress?.overallBefore ?? undefined,
          overallCurrent: finalReport.overallRiskScore ?? 0,
          lastMessage: failures.length ? `完成（有 ${failures.length} 段未能自动改写）` : "完成",
        },
        failures: failures.slice(-80),
      },
    });
  } catch (e) {
    const doneAt = Date.now();
    const err = e as unknown as HttpError;
    params.store.update(params.sessionId, {
      autoRewriteJob: {
        jobId: params.jobId,
        status: "failed",
        createdAt: session.autoRewriteJob?.createdAt ?? doneAt,
        updatedAt: doneAt,
        finishedAt: doneAt,
        params: params.body,
        progress: {
          roundsUsed,
          processed: attempted,
          maxTotal: params.body.maxTotal,
          succeeded,
          failed: failures.length,
          overallBefore: session.autoRewriteJob?.progress?.overallBefore ?? undefined,
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
  paragraphs: Array<{ id: string; index: number; kind: "paragraph" | "tableCellParagraph"; text: string }>,
  revised: Record<string, string>
) {
  return paragraphs.map((p) => ({
    id: p.id,
    index: p.index,
    kind: p.kind,
    text: revised[p.id] ?? p.text,
  }));
}

