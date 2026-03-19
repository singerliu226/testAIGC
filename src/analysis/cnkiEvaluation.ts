export type CnkiAlignmentSample = {
  documentId: string;
  title?: string;
  language?: "zh" | "en";
  documentType?: string;
  sourceFile?: string;
  rawLocalScore: number;
  predictedCnkiScore: number;
  actualCnkiScore: number;
  predictedHighRiskParagraphIds: string[];
  actualHighRiskParagraphIds?: string[];
  roleTagsHit: string[];
  evidence?: {
    actualScoreSource?: string;
    actualParagraphSource?: string;
  };
  notes?: string;
};

export type CnkiAlignmentMetrics = {
  totalSamples: number;
  scoreMae: number;
  scoreRmse: number;
  highRiskParagraph: {
    precision: number;
    recall: number;
    f1: number;
    coverage: number;
  };
  roleHitRate: Record<string, number>;
  byLanguage: Record<string, { sampleCount: number; scoreMae: number; scoreRmse: number }>;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 基于真实知网样本计算总分误差与高风险段定位指标。
 *
 * 设计原因：
 * - “总分接近”与“高风险段找得准”是两套不同目标，必须同时量化；
 * - 把评估逻辑做成纯函数，脚本、测试和后续调参工具都能复用。
 */
export function evaluateCnkiAlignmentSamples(
  samples: CnkiAlignmentSample[]
): CnkiAlignmentMetrics {
  if (samples.length === 0) {
    return {
      totalSamples: 0,
      scoreMae: 0,
      scoreRmse: 0,
      highRiskParagraph: { precision: 0, recall: 0, f1: 0, coverage: 0 },
      roleHitRate: {},
      byLanguage: {},
    };
  }

  let absErrorSum = 0;
  let sqErrorSum = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  const roleCounts = new Map<string, number>();
  const byLanguage = new Map<string, { sampleCount: number; absErrorSum: number; sqErrorSum: number }>();
  let paragraphLabeledSamples = 0;

  for (const sample of samples) {
    const diff = sample.predictedCnkiScore - sample.actualCnkiScore;
    absErrorSum += Math.abs(diff);
    sqErrorSum += diff * diff;

    const language = sample.language ?? "unknown";
    const langStats = byLanguage.get(language) ?? { sampleCount: 0, absErrorSum: 0, sqErrorSum: 0 };
    langStats.sampleCount += 1;
    langStats.absErrorSum += Math.abs(diff);
    langStats.sqErrorSum += diff * diff;
    byLanguage.set(language, langStats);

    if (Array.isArray(sample.actualHighRiskParagraphIds)) {
      paragraphLabeledSamples += 1;
      const predicted = new Set(sample.predictedHighRiskParagraphIds);
      const actual = new Set(sample.actualHighRiskParagraphIds);

      for (const id of predicted) {
        if (actual.has(id)) truePositive += 1;
        else falsePositive += 1;
      }
      for (const id of actual) {
        if (!predicted.has(id)) falseNegative += 1;
      }
    }

    for (const role of sample.roleTagsHit) {
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }
  }

  const precision =
    truePositive + falsePositive > 0 ? truePositive / (truePositive + falsePositive) : 0;
  const recall = truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const roleHitRate: Record<string, number> = {};
  for (const [role, count] of roleCounts.entries()) {
    roleHitRate[role] = round2(count / samples.length);
  }

  const byLanguageMetrics: CnkiAlignmentMetrics["byLanguage"] = {};
  for (const [language, stats] of byLanguage.entries()) {
    byLanguageMetrics[language] = {
      sampleCount: stats.sampleCount,
      scoreMae: round2(stats.absErrorSum / stats.sampleCount),
      scoreRmse: round2(Math.sqrt(stats.sqErrorSum / stats.sampleCount)),
    };
  }

  return {
    totalSamples: samples.length,
    scoreMae: round2(absErrorSum / samples.length),
    scoreRmse: round2(Math.sqrt(sqErrorSum / samples.length)),
    highRiskParagraph: {
      precision: round2(precision),
      recall: round2(recall),
      f1: round2(f1),
      coverage: round2(paragraphLabeledSamples / samples.length),
    },
    roleHitRate,
    byLanguage: byLanguageMetrics,
  };
}
