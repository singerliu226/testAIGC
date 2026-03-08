import type { AppLogger } from "../../logger/index.js";
import type { FindingSignal } from "../../report/schema.js";
import { rewriteParagraphWithDashscope } from "../../llm/rewriter.js";
import { validateRewriteGuard } from "../../llm/rewriteGuard.js";
import { calcFinalChargePoints, estimatePrechargePoints, loadBillingConfigFromEnv } from "../../billing/pricing.js";
import { randomUUID } from "node:crypto";
import type { SessionRecord } from "../sessionStore.js";
import { ledger } from "../../billing/index.js";
import { detectAigcRisk } from "../../analysis/detector.js";
import { HttpError } from "../errors.js";

export type RewriteOneInternalDeps = {};

export type RewriteOneInternalResult =
  | {
      ok: true;
      revisedText: string;
      rewriteResult: NonNullable<SessionRecord["rewriteResults"]>[string];
    }
  | {
      ok: false;
      failure: { code: string; message: string };
    };

export async function rewriteOneInternal(params: {
  deps: RewriteOneInternalDeps;
  logger: AppLogger;
  sessionId: string;
  accountId: string;
  isAdmin: boolean;
  type: "rewrite" | "auto";
  paragraph: NonNullable<SessionRecord["paragraphs"]>[number];
  baseText: string;
  contextBefore?: string;
  contextAfter?: string;
  signals: FindingSignal[];
  riskBefore: number;
  allowFactRisk?: boolean;
}): Promise<RewriteOneInternalResult> {
  const cfg = loadBillingConfigFromEnv();
  const callId = randomUUID();
  const prechargePoints = estimatePrechargePoints({ text: params.baseText, cfg });

  if (!params.isAdmin) {
    ledger.charge(params.accountId, prechargePoints, {
      billing: "llm",
      callId,
      type: params.type,
      sessionId: params.sessionId,
      paragraphId: params.paragraph.id,
      pointsEstimated: prechargePoints,
      billingMode: cfg.mode,
    });
  }

  try {
    /**
     * 自动降分的高风险段落（>=70）更需要“结构级重写”，否则容易出现“改了但分不动”。
     * 因此：auto + high risk 默认直接走 aggressive + factLock（风险模式除外）。
     */
    const startAggressive = params.type === "auto" && params.riskBefore >= 70 && !params.allowFactRisk;
    const attempt1 = await rewriteParagraphWithDashscope({
      logger: params.logger,
      paragraphText: params.baseText,
      contextBefore: params.contextBefore,
      contextAfter: params.contextAfter,
      signals: params.signals,
      rewriteMode: startAggressive ? "aggressive" : "normal",
      minChangeRatio: startAggressive ? 0.32 : undefined,
      factLock: startAggressive,
    });
    const guard1 = params.allowFactRisk
      ? ({ ok: true } as const)
      : validateRewriteGuard({
          originalText: params.paragraph.text,
          revisedText: attempt1.revisedText,
        });

    const sim1 = bigramJaccardSimilarity(params.paragraph.text, attempt1.revisedText);
    const riskAfter1 = safeParagraphRiskScore(attempt1.revisedText, params.paragraph);

    const needsRetry = !guard1.ok || sim1 >= 0.92 || riskAfter1 >= params.riskBefore - 5;
    let chosen = attempt1;
    let retryUsed = false;
    let chosenSim = sim1;
    let chosenRiskAfter = riskAfter1;

    if (needsRetry) {
      retryUsed = true;
      const attempt2 = await rewriteParagraphWithDashscope({
        logger: params.logger,
        paragraphText: params.baseText,
        contextBefore: params.contextBefore,
        contextAfter: params.contextAfter,
        signals: params.signals,
        rewriteMode: "aggressive",
        minChangeRatio: 0.3,
        // 强力改写阶段启用事实锚点锁定：允许更激进的结构改写，同时降低护栏拦截率
        factLock: !params.allowFactRisk,
      });
      const guard2 = params.allowFactRisk
        ? ({ ok: true } as const)
        : validateRewriteGuard({
            originalText: params.paragraph.text,
            revisedText: attempt2.revisedText,
          });
      if (!guard2.ok) {
        // 关键：不要直接失败。把护栏拦截原因反馈给模型，让其“删除新增锚点并重写”
        const hint = guard2.violations
          .slice(0, 6)
          .map((v) => `${v.ruleId}:${v.evidence}`)
          .join("；");
        const attempt3 = await rewriteParagraphWithDashscope({
          logger: params.logger,
          paragraphText: params.baseText,
          contextBefore: params.contextBefore,
          contextAfter: params.contextAfter,
          signals: params.signals,
          rewriteMode: "repair",
          // 修复阶段同样启用事实锁定（风险模式除外）
          factLock: !params.allowFactRisk,
          guardViolationsHint: hint,
        });
        const guard3 = params.allowFactRisk
          ? ({ ok: true } as const)
          : validateRewriteGuard({
              originalText: params.paragraph.text,
              revisedText: attempt3.revisedText,
            });
        if (!guard3.ok) {
          // 最后一层兜底：若只是“新增地点/机构”，自动泛化替换后再校验，尽量让段落落地
          const fixed = sanitizeNewAnchors(attempt3.revisedText, guard3.violations);
          if (fixed.changed) {
            const guard4 = validateRewriteGuard({
              originalText: params.paragraph.text,
              revisedText: fixed.text,
            });
            if (guard4.ok) {
              chosen = {
                ...attempt3,
                revisedText: fixed.text,
                needHumanCheck: [
                  ...(attempt3.needHumanCheck ?? []),
                  "系统已自动将新增地点/机构替换为泛化表达（如“部分地区/相关机构”），请人工确认语义是否仍准确。",
                ],
              };
              chosenSim = bigramJaccardSimilarity(params.paragraph.text, fixed.text);
              chosenRiskAfter = safeParagraphRiskScore(fixed.text, params.paragraph);
            } else {
              const summary = guard4.violations
                .slice(0, 3)
                .map((v) => `${v.ruleId}:${v.evidence}`)
                .join("；");
              return {
                ok: false,
                failure: {
                  code: "REWRITE_GUARDRAIL",
                  message: `该段改写被拦截（修复/自动泛化后仍失败）：${summary}`,
                },
              };
            }
          } else {
            const summary = guard3.violations
              .slice(0, 3)
              .map((v) => `${v.ruleId}:${v.evidence}`)
              .join("；");
            return {
              ok: false,
              failure: {
                code: "REWRITE_GUARDRAIL",
                message: `该段改写被拦截（修复重试后仍失败）：${summary}`,
              },
            };
          }
        } else {
          // repair 合格，直接采用
          chosen = attempt3;
          chosenSim = bigramJaccardSimilarity(params.paragraph.text, attempt3.revisedText);
          chosenRiskAfter = safeParagraphRiskScore(attempt3.revisedText, params.paragraph);
        }
      }
      const sim2 = bigramJaccardSimilarity(params.paragraph.text, attempt2.revisedText);
      const riskAfter2 = safeParagraphRiskScore(attempt2.revisedText, params.paragraph);

      // 两者都合规时，优先降分更明显；降分一致则选更不相似的
      if (riskAfter2 < riskAfter1 || (riskAfter2 === riskAfter1 && sim2 < sim1)) {
        chosen = attempt2;
        chosenSim = sim2;
        chosenRiskAfter = riskAfter2;
      }
    }

    const finalPoints = calcFinalChargePoints({
      text: chosen.revisedText,
      usage: chosen.usage,
      cfg,
    });
    const settle = finalPoints - prechargePoints;

    if (!params.isAdmin && settle !== 0) {
      if (settle > 0) {
        try {
          ledger.charge(params.accountId, settle, {
            billing: "llm",
            callId,
            type: params.type,
            sessionId: params.sessionId,
            paragraphId: params.paragraph.id,
            pointsExtra: settle,
            pointsFinal: finalPoints,
            usage: chosen.usage,
            billingMode: cfg.mode,
          });
        } catch {
          try {
            ledger.refund(params.accountId, prechargePoints, {
              billing: "llm",
              callId,
              type: params.type,
              sessionId: params.sessionId,
              paragraphId: params.paragraph.id,
              reason: "settle_insufficient",
              pointsEstimated: prechargePoints,
            });
          } catch {}
          throw new HttpError(402, "INSUFFICIENT_POINTS", "积分不足：请联系管理员充值");
        }
      } else {
        try {
          ledger.refund(params.accountId, Math.abs(settle), {
            billing: "llm",
            callId,
            type: params.type,
            sessionId: params.sessionId,
            paragraphId: params.paragraph.id,
            pointsRefund: Math.abs(settle),
            pointsFinal: finalPoints,
            usage: chosen.usage,
            billingMode: cfg.mode,
          });
        } catch {}
      }
    }

    return {
      ok: true,
      revisedText: chosen.revisedText,
      rewriteResult: {
        revisedText: chosen.revisedText,
        changeRationale: chosen.changeRationale ?? [],
        riskSignalsResolved: chosen.riskSignalsResolved ?? [],
        needHumanCheck: [
          ...(chosen.needHumanCheck ?? []),
          ...(params.allowFactRisk ? ["已启用事实风险模式：请人工核对数字/日期/地点/研究结论等是否准确"] : []),
        ],
        humanFeatures: chosen.humanFeatures ?? [],
        chargedPoints: finalPoints,
        createdAt: Date.now(),
        quality: {
          riskBefore: params.riskBefore,
          riskAfter: chosenRiskAfter,
          similarity: Number(chosenSim.toFixed(3)),
          retryUsed,
          usage: chosen.usage,
        },
      },
    };
  } catch (e) {
    if (!params.isAdmin) {
      try {
        ledger.refund(params.accountId, prechargePoints, {
          billing: "llm",
          callId,
          type: params.type,
          sessionId: params.sessionId,
          paragraphId: params.paragraph.id,
          reason: "rewrite_failed",
          pointsEstimated: prechargePoints,
        });
      } catch {}
    }
    const code = (e as any)?.code ? String((e as any).code) : "REWRITE_FAILED";
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, failure: { code, message } };
  }
}

function safeParagraphRiskScore(
  text: string,
  p: { id: string; index: number; kind: "paragraph" | "tableCellParagraph"; text: string }
): number {
  try {
    const r = detectAigcRisk([{ id: p.id, index: p.index, kind: p.kind, text }]);
    return r.paragraphReports?.[0]?.riskScore ?? 0;
  } catch {
    return 0;
  }
}

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

function sanitizeNewAnchors(
  text: string,
  violations: Array<{ ruleId: string; evidence: string }>
): { text: string; changed: boolean } {
  let out = String(text ?? "");
  let changed = false;

  const extractList = (evidence: string) => {
    const idx = evidence.indexOf("：");
    const s = idx >= 0 ? evidence.slice(idx + 1) : evidence;
    return s
      .split(/[、,，]/g)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 12);
  };

  for (const v of violations) {
    if (v.ruleId === "new_places") {
      for (const frag of extractList(v.evidence)) {
        if (!frag) continue;
        const repl =
          /(?:路|街|大道|巷)$/.test(frag) ? "某地" : /(?:省|市|区|县|镇|乡|港|站|桥|河|湖|山)$/.test(frag) ? "部分地区" : "相关地区";
        if (out.includes(frag)) {
          out = out.split(frag).join(repl);
          changed = true;
        }
      }
    }
    if (v.ruleId === "new_orgs") {
      for (const frag of extractList(v.evidence)) {
        if (!frag) continue;
        const repl = "相关机构";
        if (out.includes(frag)) {
          out = out.split(frag).join(repl);
          changed = true;
        }
      }
    }
  }

  return { text: out, changed };
}

