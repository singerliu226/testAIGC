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


  // ──────────────────────────────────────────────────────────────────────────
  // 以下 5 条为知网高频触发盲区补充，覆盖原有 7 条未涉及的场景
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 引言套话：知网对"随着X的发展/在X背景下"等开篇套话高度敏感。
   * 这类表达是 AI 生成引言的最高频模式，知网已专项建库。
   * 触发条件不限制角色，任意段落命中均计入。
   */
  const introFormulaCount = countMatches(
    text,
    /(随着.{0,20}(深入|快速|迅速|广泛)?(发展|推进|普及|兴起)|在.{0,20}(背景下|形势下|环境下|语境下)|近年来.{0,10}(受到|引起|得到|引发)|具有重要的(研究|参考|现实|实践|理论)(意义|价值))/
  );
  if (introFormulaCount >= 1) {
    signals.push({
      signalId: "cnki_intro_formula",
      category: "cnkiSensitive",
      title: "包含知网高敏引言套话",
      evidence: [`命中"随着…发展/在…背景下/近年来/具有重要意义"等引言套话 ${introFormulaCount} 处`],
      suggestion: "删除段首套话，直接从核心问题或关键发现切入，避免\"背景→意义\"的 AI 式铺垫。",
      score: 17,
    });
  }

  /**
   * 结论套话：知网对论文结尾模板尤为敏感。
   * "综上所述/通过本文研究/本文得出以下结论"是知网已建库的高频模板短语。
   * 触发条件不限制角色，任意段落命中均计入。
   */
  const conclusionFormulaCount = countMatches(
    text,
    /(综上所述|通过本(文|研究|论文)(的)?(研究|分析|探讨)|本(文|研究|论文)(得出|发现|表明|认为|的结论|旨在说明)|研究结果(表明|显示|证明)|本文(的|)研究(结论|发现|结果))/
  );
  if (conclusionFormulaCount >= 1) {
    signals.push({
      signalId: "cnki_conclusion_boilerplate",
      category: "cnkiSensitive",
      title: "包含知网高敏结论套话",
      evidence: [`命中"综上所述/通过本文研究/本文得出"等结论套话 ${conclusionFormulaCount} 处`],
      suggestion: "删除模板式总结开头，直接呈现核心发现，并说明其对理论或实践的具体贡献。",
      score: 16,
    });
  }

  /**
   * 三段式并列结构：知网将"一是…二是…三是…"或"首先/其次/再次"连续 3 组以上识别为 AI 模板结构。
   * 这类结构高度机械化，是中文 AI 写作的典型标志。
   */
  const parallelOneTwo = countMatches(text, /(一是|二是|三是|四是|五是)/);
  const parallelFirstSecond = countMatches(text, /(首先|其次|再次|最后)/);
  const parallelHit = parallelOneTwo >= 3 || parallelFirstSecond >= 3;
  if (parallelHit) {
    signals.push({
      signalId: "cnki_parallel_structure",
      category: "cnkiSensitive",
      title: "连续并列三要素以上的 AI 模板结构",
      evidence: [
        parallelOneTwo >= 3 ? `"一是/二是/三是"等并列出现 ${parallelOneTwo} 处` : "",
        parallelFirstSecond >= 3 ? `"首先/其次/再次/最后"连续出现 ${parallelFirstSecond} 处` : "",
      ].filter(Boolean),
      suggestion: "改用论证关系（因果/对比/递进）代替机械并列，把各要素之间的逻辑联系说清楚。",
      score: 15,
    });
  }

  /**
   * 模糊限定链：知网对连续模糊限定语（"可能/一定程度上/有待进一步"）高度敏感。
   * AI 为了"显得严谨"而堆砌模糊限定，是其写作的典型特征。
   */
  const hedgeCount = countMatches(
    text,
    /(可能|或许|也许|在一定(程度上|范围内)|在某种(程度上|意义上)|有待(进一步|深入)|尚需(进一步|深入)|仍需(进一步|深入))/
  );
  if (hedgeCount >= 3) {
    signals.push({
      signalId: "cnki_hedge_chain",
      category: "cnkiSensitive",
      title: "连续模糊限定语堆叠",
      evidence: [`"可能/在一定程度上/有待进一步"等模糊限定语出现 ${hedgeCount} 处`],
      suggestion: "减少空洞的不确定性表述，改为说明具体的边界条件或约束来源。",
      score: 12,
    });
  }

  /**
   * 高抽象名词密度：知网对"层面/维度/路径/机制/框架"等高频抽象名词密集堆叠极为敏感。
   * 实现：计算每百字命中数，密度过高且无具体数字/引用时触发。
   * 不限制角色，任意段落均可触发。
   */
  const abstractCount = countMatches(text, /(层面|维度|路径|机制|模式|框架|体系|格局|逻辑|生态)/);
  const hasConcrete = /\d+(\.\d+)?(%|个|项|名|万|亿|次|篇|年|月|日)/.test(text) || /【[^\]]+】|\[[^\]]+\]/.test(text);
  const abstractDensity = text.length > 0 ? (abstractCount / text.length) * 100 : 0;
  if (abstractCount >= 4 && abstractDensity > 1.5 && !hasConcrete) {
    signals.push({
      signalId: "cnki_abstract_dense",
      category: "cnkiSensitive",
      title: "高抽象名词密度且缺乏具体数据支撑",
      evidence: [`"层面/维度/路径/机制/框架"等抽象名词出现 ${abstractCount} 处，密度 ${abstractDensity.toFixed(1)}/百字，且无具体数字/引用`],
      suggestion: "把抽象表述落地：指明是哪个具体的层面/路径/机制，或用具体数据/案例/引用替换。",
      score: 13,
    });
  }

  return signals;
}