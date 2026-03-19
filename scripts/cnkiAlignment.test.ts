import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateCnkiAlignmentSamples } from "../src/analysis/cnkiEvaluation.js";
import { loadCnkiAlignmentSamples } from "../src/scripts/evaluateCnkiAlignment.js";
import { detectAigcRisk } from "../src/analysis/detector.js";
import { fuseCnkiJudgeScore, shouldReviewWithCnkiJudge } from "../src/analysis/cnkiLlmFusion.js";
import { buildCnkiSensitiveSignals } from "../src/analysis/cnkiSensitiveRules.js";
import { detectCnkiRoleTags } from "../src/analysis/cnkiRoleFeatures.js";

const roadmapText =
  "本文共分为五章。第一章介绍研究背景与问题提出，第二章梳理相关文献，第三章说明研究方法，第四章展开分析，第五章总结研究结论。";

const significanceText =
  "本研究具有重要的理论意义和实践价值，不仅有助于丰富相关研究，也能够为现实工作提供参考。";

const litReviewText =
  "张三认为短视频传播强化了情绪动员，李四指出平台算法改变了信息分发逻辑，王五提出用户互动机制会进一步放大舆论扩散效应。";

const paragraphs = [
  { id: "p-0", index: 0, kind: "paragraph" as const, text: "1.4 研究意义" },
  { id: "p-1", index: 1, kind: "paragraph" as const, text: significanceText },
  { id: "p-2", index: 2, kind: "paragraph" as const, text: "1.5 章节安排" },
  { id: "p-3", index: 3, kind: "paragraph" as const, text: roadmapText },
  { id: "p-4", index: 4, kind: "paragraph" as const, text: "2.1 文献综述" },
  { id: "p-5", index: 5, kind: "paragraph" as const, text: litReviewText },
];

const roleTagsForRoadmap = detectCnkiRoleTags({
  paragraphText: roadmapText,
  paragraphIndex: 3,
  allParagraphs: paragraphs,
});
assert.ok(roleTagsForRoadmap.includes("chapterRoadmap"), "章节安排段应识别为 chapterRoadmap");

const roleTagsForSignificance = detectCnkiRoleTags({
  paragraphText: significanceText,
  paragraphIndex: 1,
  allParagraphs: paragraphs,
});
assert.ok(
  roleTagsForSignificance.includes("researchSignificance"),
  "研究意义段应识别为 researchSignificance"
);

const falseHeadingParagraphs = [
  {
    id: "fh-0",
    index: 0,
    kind: "paragraph" as const,
    text: "这一部分会补充研究背景的现实来源，并解释后续材料筛选时为何要压缩样本范围。",
  },
  {
    id: "fh-1",
    index: 1,
    kind: "paragraph" as const,
    text: "样本筛选主要依据文本可比性，而不是预设的章节划分。",
  },
];
assert.deepEqual(
  detectCnkiRoleTags({
    paragraphText: falseHeadingParagraphs[1].text,
    paragraphIndex: 1,
    allParagraphs: falseHeadingParagraphs,
  }),
  [],
  "普通正文不应因为上一段提到“研究背景”就被误识别为标题邻接段"
);

const cnkiSignals = buildCnkiSensitiveSignals({
  paragraphText: litReviewText,
  roleTags: ["literatureReview"],
});
assert.ok(
  cnkiSignals.some((s) => s.signalId === "cnki_reference_parade"),
  "文献罗列段应命中 cnki_reference_parade"
);

const report = detectAigcRisk(paragraphs);
assert.equal(
  typeof report.overallCnkiPredictedScore,
  "number",
  "检测报告应输出 overallCnkiPredictedScore"
);

const significanceReport = report.paragraphReports.find((r) => r.paragraphId === "p-1");
assert.ok(significanceReport, "应存在研究意义段报告");
assert.ok(
  Array.isArray(significanceReport?.roleTags) &&
    significanceReport?.roleTags.includes("researchSignificance"),
  "段落报告应包含 roleTags"
);
assert.ok(
  typeof significanceReport?.cnkiRiskScore === "number" &&
    significanceReport.cnkiRiskScore >= significanceReport.riskScore,
  "知网代理分对高敏模板段不应低于原始风险分"
);

assert.equal(
  shouldReviewWithCnkiJudge({
    riskScore: 36,
    cnkiRiskScore: 61,
    roleTags: ["researchSignificance"],
  }),
  true,
  "高敏角色且知网代理分高的段落应进入 LLM 复核"
);

assert.equal(
  fuseCnkiJudgeScore({
    rawRiskScore: 40,
    judgeRiskScore: 80,
    roleTags: ["chapterRoadmap"],
  }),
  68,
  "高敏角色段应更信任 LLM 复核结果"
);

const metrics = evaluateCnkiAlignmentSamples([
  {
    documentId: "doc-a",
    rawLocalScore: 22,
    predictedCnkiScore: 31,
    actualCnkiScore: 35,
    predictedHighRiskParagraphIds: ["p1", "p2"],
    actualHighRiskParagraphIds: ["p2", "p3"],
    roleTagsHit: ["literatureReview", "researchMethod"],
  },
  {
    documentId: "doc-b",
    rawLocalScore: 18,
    predictedCnkiScore: 26,
    actualCnkiScore: 20,
    predictedHighRiskParagraphIds: ["p9"],
    actualHighRiskParagraphIds: ["p9"],
    roleTagsHit: ["chapterRoadmap"],
  },
]);
assert.equal(metrics.totalSamples, 2, "评估脚本应统计样本数");
assert.equal(metrics.scoreMae, 5, "MAE 应按预测分与真实分绝对误差计算");
assert.equal(metrics.highRiskParagraph.precision, 0.67, "应输出高风险段定位精度");

const scoreOnlyMetrics = evaluateCnkiAlignmentSamples([
  {
    documentId: "score-only",
    rawLocalScore: 14,
    predictedCnkiScore: 14,
    actualCnkiScore: 31.4,
    predictedHighRiskParagraphIds: [],
    roleTagsHit: ["literatureReview"],
  },
]);
assert.equal(scoreOnlyMetrics.highRiskParagraph.coverage, 0, "没有段落标注时应跳过段落定位指标");
assert.equal(scoreOnlyMetrics.scoreMae, 17.4, "应支持只有总分标签的真实样本");

const tempDir = join(tmpdir(), `cnki-alignment-${Date.now()}`);
await mkdir(tempDir, { recursive: true });
await writeFile(
  join(tempDir, "a.json"),
  JSON.stringify([
    {
      documentId: "dir-a",
      rawLocalScore: 20,
      predictedCnkiScore: 28,
      actualCnkiScore: 30,
      predictedHighRiskParagraphIds: [],
      roleTagsHit: ["chapterRoadmap"],
    },
  ]),
  "utf-8"
);
await writeFile(
  join(tempDir, "b.json"),
  JSON.stringify([
    {
      documentId: "dir-b",
      rawLocalScore: 10,
      predictedCnkiScore: 18,
      actualCnkiScore: 22,
      predictedHighRiskParagraphIds: [],
      roleTagsHit: ["researchSignificance"],
    },
  ]),
  "utf-8"
);
const loaded = await loadCnkiAlignmentSamples(tempDir);
assert.equal(loaded.length, 2, "评估脚本应支持从目录批量加载样本");

console.log("cnkiAlignment tests passed");
