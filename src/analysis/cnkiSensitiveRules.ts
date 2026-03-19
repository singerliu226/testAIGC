import type { FindingSignal } from "../report/schema.js";
import type { CnkiRoleTag } from "./cnkiRoleFeatures.js";

export type BuildCnkiSensitiveSignalsInput = {
  paragraphText: string;
  roleTags: CnkiRoleTag[];
};

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) ?? []).length;
}

/**
 * 构建更贴近知网高敏段的专项信号。
 *
 * 实现原则：
 * - 不取代现有通用规则，只补充“中文论文模板段”这一层；
 * - 信号尽量依赖段落角色 + 句式模式，而不是单一短语命中；
 * - 保持可解释，便于前端和人工复核直接看到命中原因。
 */
export function buildCnkiSensitiveSignals(
  input: BuildCnkiSensitiveSignalsInput
): FindingSignal[] {
  const text = input.paragraphText ?? "";
  const signals: FindingSignal[] = [];
  const hasRole = (role: CnkiRoleTag) => input.roleTags.includes(role);

  const scholarParadeCount = countMatches(text, /[一-龥]{2,4}(认为|指出|提出|发现|主张)/);
  const chapterMarkers = (text.match(/第[一二三四五六七八九十0-9]+章/g) ?? []).length;

  if (hasRole("literatureReview") && scholarParadeCount >= 2) {
    signals.push({
      signalId: "cnki_reference_parade",
      category: "cnkiSensitive",
      title: "文献综述呈现“学者观点串联式罗列”",
      evidence: [`学者观点串联命中 ${scholarParadeCount} 处`],
      suggestion: "不要只罗列“谁说了什么”，要补上比较、分歧或研究空缺，再引向你的切入点。",
      score: 16,
    });
  }

  if (
    hasRole("literatureReview") &&
    /(已有研究|现有研究|相关研究)/.test(text) &&
    /(但是|然而|不过|不足|局限|尚未)/.test(text) &&
    /(本文|本研究).{0,10}(旨在|将|试图)/.test(text)
  ) {
    signals.push({
      signalId: "cnki_lit_review_boilerplate",
      category: "cnkiSensitive",
      title: "文献综述存在“综述后硬转本文”的模板结构",
      evidence: ["出现“已有研究/不足/本文旨在”三段式切换"],
      suggestion: "把“研究空缺”说得更具体，用问题或争议承接，而不是机械转入“本文将…”。",
      score: 18,
    });
  }

  if (
    hasRole("researchSignificance") &&
    /(理论意义|实践意义|现实意义|应用价值|具有重要意义|具有重要价值)/.test(text)
  ) {
    signals.push({
      signalId: "cnki_significance_template",
      category: "cnkiSensitive",
      title: "研究意义段使用知网高敏模板表达",
      evidence: ["命中“理论意义/实践意义/具有重要意义”等价值判断模板"],
      suggestion: "把“意义”改成更具体的影响对象、适用边界或问题修正，不要停留在价值套话。",
      score: 18,
    });
  }

  if (
    hasRole("researchMethod") &&
    (/(采用|运用|使用).{0,20}(方法|路径|策略)/.test(text) ||
      /(文献分析|文本分析|案例分析|问卷调查|访谈法|比较分析)/.test(text))
  ) {
    signals.push({
      signalId: "cnki_method_template",
      category: "cnkiSensitive",
      title: "研究方法段呈现标准化“方法清单”模板",
      evidence: ["命中“采用…方法/文献分析/文本分析”等方法说明模板"],
      suggestion: "除了列出方法，还要说明为什么选这些方法、它们如何配合，而不是只给方法名单。",
      score: 16,
    });
  }

  if (hasRole("chapterRoadmap") && (chapterMarkers >= 2 || /本文(?:共|主要|整体)?分为/.test(text))) {
    signals.push({
      signalId: "cnki_roadmap_template",
      category: "cnkiSensitive",
      title: "章节安排段呈现典型 roadmap 模板",
      evidence: [`章节标记命中 ${chapterMarkers} 处`],
      suggestion: "尽量弱化逐章列举，改为概括研究推进逻辑，而不是目录式介绍。",
      score: 20,
    });
  }

  if (
    (hasRole("limitations") || hasRole("futureWork")) &&
    /(局限|不足|未来研究|后续研究|进一步研究)/.test(text)
  ) {
    signals.push({
      signalId: "cnki_limit_future_template",
      category: "cnkiSensitive",
      title: "局限/展望段落使用固定论文收束模板",
      evidence: ["命中“局限/不足/未来研究”等结尾模板句式"],
      suggestion: "把局限和未来方向写成具体边界条件与可执行延伸，而不是公式化收尾。",
      score: 15,
    });
  }

  if (
    hasRole("theoreticalFramework") &&
    /(起源于|源于|来自|可以分为|发展阶段|第一阶段|第二阶段|由.{0,12}提出)/.test(text)
  ) {
    signals.push({
      signalId: "cnki_theory_textbook_style",
      category: "cnkiSensitive",
      title: "理论框架段偏“教材式铺陈”",
      evidence: ["命中理论起源/阶段划分/提出者介绍等教材式句型"],
      suggestion: "减少教科书式介绍，更多说明该理论与本文问题的直接关联。",
      score: 14,
    });
  }

  return signals;
}
