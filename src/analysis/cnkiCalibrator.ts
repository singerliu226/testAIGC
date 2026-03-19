import type { FindingSignal, ParagraphReport } from "../report/schema.js";
import { clamp } from "./textUtils.js";
import type { CnkiRoleTag } from "./cnkiRoleFeatures.js";

export type CnkiParagraphScoreInput = {
  rawRiskScore: number;
  roleTags: CnkiRoleTag[];
  signals: FindingSignal[];
  text: string;
};

const ROLE_BONUS: Partial<Record<CnkiRoleTag, number>> = {
  chapterRoadmap: 10,
  literatureReview: 8,
  researchSignificance: 8,
  researchMethod: 6,
  theoreticalFramework: 6,
  limitations: 5,
  futureWork: 5,
  conclusionSummary: 4,
  researchPurpose: 4,
  researchBackground: 3,
};

const ROLE_MULTIPLIER: Partial<Record<CnkiRoleTag, number>> = {
  chapterRoadmap: 1.35,
  literatureReview: 1.25,
  researchSignificance: 1.2,
  researchMethod: 1.15,
  limitations: 1.15,
  futureWork: 1.15,
  theoreticalFramework: 1.1,
  conclusionSummary: 1.1,
};

const VALID_ROLE_TAGS = new Set<CnkiRoleTag>([
  "chapterRoadmap",
  "researchBackground",
  "literatureReview",
  "researchPurpose",
  "researchSignificance",
  "researchMethod",
  "theoreticalFramework",
  "limitations",
  "futureWork",
  "conclusionSummary",
]);

function paragraphRoleMultiplier(roleTags: CnkiRoleTag[]): number {
  let multiplier = 1;
  for (const role of roleTags) {
    multiplier = Math.max(multiplier, ROLE_MULTIPLIER[role] ?? 1);
  }
  return multiplier;
}

function normalizeRoleTags(roleTags: string[]): CnkiRoleTag[] {
  return roleTags.filter((role): role is CnkiRoleTag => VALID_ROLE_TAGS.has(role as CnkiRoleTag));
}

/**
 * 计算更贴近知网口径的段落代理分。
 *
 * 实现思路：
 * - 以原始规则分为底座，避免完全偏离现有体系；
 * - 用高敏角色与专项信号做“向上校准”，解决当前系统对中文论文模板段低估的问题；
 * - 不直接把专项信号裸加到原始分里，避免破坏现有解释口径。
 */
export function computeCnkiParagraphScore(input: CnkiParagraphScoreInput): number {
  const sensitiveSignals = input.signals.filter((s) => s.category === "cnkiSensitive");
  const roleBonus = input.roleTags.reduce((sum, role) => sum + (ROLE_BONUS[role] ?? 0), 0);
  const signalBonus = sensitiveSignals.reduce((sum, signal) => sum + signal.score, 0) * 0.45;
  const multiplier = paragraphRoleMultiplier(input.roleTags);

  const adjusted = Math.round(input.rawRiskScore * multiplier + roleBonus + signalBonus);
  return clamp(Math.max(input.rawRiskScore, adjusted), 0, 100);
}

function isHeadingLike(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.length <= 26 && /^(第[一二三四五六七八九十0-9]+[章节部分]|[0-9]+(\.[0-9]+)*)/.test(trimmed);
}

function isReferenceLike(text: string): boolean {
  return /^参考文献/.test(text.trim()) || /^[一-龥A-Za-z]{1,12}\.\s*.+\[\w\]/.test(text.trim());
}

/**
 * 复用旧的总分算法，明确输出“原始分轨道”。
 */
export function computeRawOverallScore(
  paragraphReports: Array<Pick<ParagraphReport, "text" | "riskScore">>
): number {
  let aiCharCount = 0;
  let totalCharCount = 0;
  for (const report of paragraphReports) {
    const charLen = report.text.length;
    totalCharCount += charLen;
    if (report.riskScore >= 35) {
      aiCharCount += charLen * (report.riskScore / 100);
    }
  }
  return totalCharCount > 0 ? clamp(Math.round((aiCharCount / totalCharCount) * 100), 0, 100) : 0;
}

/**
 * 计算知网代理总分。
 *
 * 设计原因：
 * - 知网对长段落、模板段和论文功能段通常更敏感，因此总分不能只做简单字符平均；
 * - 但仍保持“字符权重”作为主轴，避免被少量短段异常值主导。
 */
export function computeCnkiOverallScore(
  paragraphReports: Array<Pick<ParagraphReport, "text" | "cnkiRiskScore" | "roleTags">>
): number {
  let weightedAi = 0;
  let weightedTotal = 0;

  let sensitiveRoleCount = 0;
  let roadmapCount = 0;
  let litReviewCount = 0;

  for (const report of paragraphReports) {
    const text = report.text;
    const baseLen = text.length;
    if (!baseLen) continue;

    let weight = 1;
    if (isHeadingLike(text)) weight *= 0.35;
    if (isReferenceLike(text)) weight *= 0.2;

    const roleTags = normalizeRoleTags(report.roleTags ?? []);
    if (roleTags.length > 0) {
      sensitiveRoleCount += 1;
      weight *= paragraphRoleMultiplier(roleTags);
    }
    if (roleTags.includes("chapterRoadmap")) roadmapCount += 1;
    if (roleTags.includes("literatureReview")) litReviewCount += 1;

    const effectiveLen = baseLen * weight;
    weightedTotal += effectiveLen;
    if (report.cnkiRiskScore >= 30) {
      weightedAi += effectiveLen * (report.cnkiRiskScore / 100);
    }
  }

  let score = weightedTotal > 0 ? Math.round((weightedAi / weightedTotal) * 100) : 0;
  if (sensitiveRoleCount >= 4) score += 3;
  if (roadmapCount >= 1) score += 2;
  if (litReviewCount >= 2) score += 2;

  return clamp(score, 0, 100);
}
