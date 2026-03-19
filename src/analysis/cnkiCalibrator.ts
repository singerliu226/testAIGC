import type { FindingSignal, ParagraphReport } from "../report/schema.js";
import { clamp } from "./textUtils.js";
import type { CnkiRoleTag } from "./cnkiRoleFeatures.js";

export type CnkiParagraphScoreInput = {
  rawRiskScore: number;
  roleTags: CnkiRoleTag[];
  signals: FindingSignal[];
  text: string;
};


/**
 * 角色加分参数（基于真实样本重拟合）。
 *
 * 原始值来自经验估计；2026-03-19 基于用户真实样本（raw=37%，知网实测=51%）
 * 发现系统整体低估约 14%，主要原因是结构模板段（chapterRoadmap/literatureReview/
 * researchSignificance）的加分严重不足。本次将核心结构段加分提升 50-75%，
 * 同时适度提升其余角色，使整体预测分向上校准。
 */
const ROLE_BONUS: Partial<Record<CnkiRoleTag, number>> = {
  chapterRoadmap: 14,       // 原 10，章节安排段是知网最高分来源之一
  literatureReview: 12,     // 原 8，文献综述是知网第二高分来源
  researchSignificance: 12, // 原 8，研究意义模板句密度极高
  researchMethod: 9,        // 原 6
  theoreticalFramework: 9,  // 原 6
  limitations: 7,           // 原 5
  futureWork: 7,            // 原 5
  conclusionSummary: 6,     // 原 4
  researchPurpose: 6,       // 原 4
  researchBackground: 4,    // 原 3
};

/**
 * 角色乘数参数（基于真实样本重拟合）。
 *
 * 知网对结构模板段的敏感度远超通用检测，chapterRoadmap 即使原始分不高
 * 也会被知网放大。乘数从 1.35 提升到 1.55，literatureReview 从 1.25->1.40。
 */
const ROLE_MULTIPLIER: Partial<Record<CnkiRoleTag, number>> = {
  chapterRoadmap: 1.55,     // 原 1.35
  literatureReview: 1.40,   // 原 1.25
  researchSignificance: 1.32, // 原 1.20
  researchMethod: 1.22,     // 原 1.15
  limitations: 1.22,        // 原 1.15
  futureWork: 1.22,         // 原 1.15
  theoreticalFramework: 1.16, // 原 1.10
  conclusionSummary: 1.14,  // 原 1.10
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
  const signalBonus = sensitiveSignals.reduce((sum, signal) => sum + signal.score, 0) * 0.65; // 原 0.45，基于真实样本重拟合
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
  // 文档级附加分（基于真实样本重拟合，从 +3/+2/+2 提升到 +5/+3/+3）
  if (sensitiveRoleCount >= 4) score += 5;
  if (roadmapCount >= 1) score += 3;
  if (litReviewCount >= 2) score += 3;

  return clamp(score, 0, 100);
}
