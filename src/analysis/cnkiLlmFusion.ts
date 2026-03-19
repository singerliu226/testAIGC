import type { ParagraphReport } from "../report/schema.js";

const SENSITIVE_ROLES = new Set([
  "chapterRoadmap",
  "literatureReview",
  "researchSignificance",
  "researchMethod",
  "limitations",
  "futureWork",
  "theoreticalFramework",
]);

/**
 * 判断某段是否值得进入中文 LLM 复核。
 *
 * 设计原因：
 * - 不能只看原始分，否则会漏掉“模板感强但表层措辞不夸张”的高敏论文段；
 * - 也不能对全文放开，否则成本和时延都会明显上升。
 */
export function shouldReviewWithCnkiJudge(input: {
  riskScore: number;
  cnkiRiskScore?: number;
  roleTags?: string[];
}): boolean {
  const highRaw = input.riskScore >= 50;
  const highCnki = (input.cnkiRiskScore ?? 0) >= 55;
  const sensitiveRoleHit = (input.roleTags ?? []).some((tag) => SENSITIVE_ROLES.has(tag));
  return highRaw || highCnki || (sensitiveRoleHit && input.riskScore >= 35);
}

/**
 * 计算规则分与 LLM 复核分的动态融合值。
 *
 * 设计原因：
 * - 高敏角色段更容易被知网视为模板段，因此对 LLM “像不像论文模板段”的判断更依赖；
 * - 普通段仍以规则分为主，避免 LLM 轻微波动放大到整篇总分。
 */
export function fuseCnkiJudgeScore(input: {
  rawRiskScore: number;
  judgeRiskScore: number;
  roleTags?: string[];
}): number {
  const sensitiveRoleHit = (input.roleTags ?? []).some((tag) => SENSITIVE_ROLES.has(tag));
  const ruleWeight = sensitiveRoleHit ? 0.3 : 0.4;
  const llmWeight = 1 - ruleWeight;
  return Math.min(
    100,
    Math.max(0, Math.round(input.rawRiskScore * ruleWeight + input.judgeRiskScore * llmWeight))
  );
}

/**
 * 对候选段做统一排序，优先处理知网代理分更高的模板段。
 */
export function sortCnkiJudgeCandidates<T extends Pick<ParagraphReport, "riskScore" | "cnkiRiskScore">>(
  items: T[]
): T[] {
  return [...items].sort(
    (a, b) =>
      Math.max(b.riskScore, b.cnkiRiskScore ?? 0) - Math.max(a.riskScore, a.cnkiRiskScore ?? 0)
  );
}
