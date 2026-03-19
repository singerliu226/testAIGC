/**
 * 中文论文段落角色识别。
 *
 * 设计原因：
 * - 知网对“段落承担什么论文功能”比对单纯措辞更敏感；
 * - 研究意义、研究方法、章节安排、文献综述等段落，即便表层语言不夸张，
 *   仍可能因模板化而被整体拉高；
 * - 先做稳定、可解释的规则识别，而不是直接引入黑盒分类器，方便后续调参。
 */

export type CnkiRoleTag =
  | "chapterRoadmap"
  | "researchBackground"
  | "literatureReview"
  | "researchPurpose"
  | "researchSignificance"
  | "researchMethod"
  | "theoreticalFramework"
  | "limitations"
  | "futureWork"
  | "conclusionSummary";

export type DetectCnkiRoleTagsInput = {
  paragraphText: string;
  paragraphIndex: number;
  allParagraphs: Array<{ index: number; text: string }>;
};

const HEADING_HINTS: Record<CnkiRoleTag, RegExp[]> = {
  chapterRoadmap: [/章节安排/, /结构安排/, /论文结构/, /内容安排/],
  researchBackground: [/研究背景/, /问题提出/, /选题背景/, /现实背景/],
  literatureReview: [/文献综述/, /研究现状/, /国内外研究/, /相关研究/],
  researchPurpose: [/研究目的/, /研究问题/, /研究目标/],
  researchSignificance: [/研究意义/, /理论意义/, /实践意义/, /现实意义/],
  researchMethod: [/研究方法/, /研究设计/, /研究思路/],
  theoreticalFramework: [/理论框架/, /理论基础/, /理论依据/, /相关理论/],
  limitations: [/研究不足/, /局限性/, /存在不足/],
  futureWork: [/未来研究/, /研究展望/, /后续研究/],
  conclusionSummary: [/结论/, /总结/, /结语/],
};

const BODY_HINTS: Record<CnkiRoleTag, RegExp[]> = {
  chapterRoadmap: [
    /本文(?:共|主要|整体)?分为.{0,12}(章|部分)/,
    /第一章.{0,30}第二章/,
    /下文(?:将|分别)?从.{0,20}(展开|论述|分析)/,
  ],
  researchBackground: [
    /^随着.{1,20}(发展|推进|深入|加快|普及)/,
    /^在.{1,20}(背景|语境|形势|情境)(下|之下)/,
    /(现实|实践)中.{0,12}(问题|困境|挑战)/,
  ],
  literatureReview: [
    /(学者|研究者).{0,6}(认为|指出|提出|发现|主张)/,
    /(已有研究|现有研究|既有研究|相关研究)/,
    /(国内外|国外|国内).{0,12}研究/,
  ],
  researchPurpose: [
    /(本文|本研究).{0,6}(旨在|试图|意在|拟)/,
    /围绕.{0,20}(研究问题|核心问题)/,
  ],
  researchSignificance: [
    /(理论意义|实践意义|现实意义|应用价值)/,
    /具有重要.{0,6}(意义|价值)/,
    /有助于.{0,12}(推动|促进|完善|丰富)/,
  ],
  researchMethod: [
    /(本文|本研究).{0,10}(采用|运用|使用).{0,20}(方法|路径|策略)/,
    /(文献分析|文本分析|案例分析|比较分析|问卷调查|访谈法|实证分析)/,
    /研究方法.{0,8}(包括|主要包括|主要有)/,
  ],
  theoreticalFramework: [
    /(理论框架|理论基础|理论依据)/,
    /(目的论|扎根理论|功能主义|媒介依赖理论|议程设置理论)/,
    /(起源于|源于|由.{0,12}提出)/,
  ],
  limitations: [
    /(存在|仍有|不可避免地存在).{0,8}(不足|局限)/,
    /(研究|本文).{0,10}(局限性|不足之处)/,
    /受限于.{0,20}(样本|方法|资料|篇幅)/,
  ],
  futureWork: [
    /(未来|后续).{0,8}(研究|可从|可进一步)/,
    /有待.{0,12}(进一步研究|继续讨论)/,
    /后续可以.{0,20}(展开|补充|深化)/,
  ],
  conclusionSummary: [
    /(综上所述|总而言之|总之|总体来看)/,
    /(研究结论|主要结论|本文认为)/,
    /由此可见/,
  ],
};

function looksLikeHeading(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length <= 24 && /^(第[一二三四五六七八九十0-9]+[章节部分]|[0-9]+(\.[0-9]+)*\s*)/.test(trimmed)) {
    return true;
  }
  // 关键词标题必须足够短，并且不能像完整句子，否则容易把正文误当成标题。
  if (trimmed.length > 18) return false;
  if (/[。！？；，]/.test(trimmed)) return false;
  return Object.values(HEADING_HINTS).some((rules) => rules.some((rule) => rule.test(trimmed)));
}

function nearestHeading(
  index: number,
  allParagraphs: Array<{ index: number; text: string }>
): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const text = allParagraphs[i]?.text?.trim() ?? "";
    if (text && looksLikeHeading(text)) return text;
  }
  return "";
}

/**
 * 基于当前段落文本 + 最近标题线索，输出可多选的论文角色标签。
 */
export function detectCnkiRoleTags(input: DetectCnkiRoleTagsInput): CnkiRoleTag[] {
  const text = (input.paragraphText ?? "").trim();
  if (!text) return [];

  const heading = nearestHeading(input.paragraphIndex, input.allParagraphs);
  const roleTags = new Set<CnkiRoleTag>();

  for (const [role, rules] of Object.entries(BODY_HINTS) as Array<[CnkiRoleTag, RegExp[]]>) {
    if (rules.some((rule) => rule.test(text))) roleTags.add(role);
  }

  for (const [role, rules] of Object.entries(HEADING_HINTS) as Array<[CnkiRoleTag, RegExp[]]>) {
    if (heading && rules.some((rule) => rule.test(heading))) roleTags.add(role);
  }

  // 章节安排段通常会罗列“第一章/第二章/第三章”
  if ((text.match(/第[一二三四五六七八九十0-9]+章/g) ?? []).length >= 2) {
    roleTags.add("chapterRoadmap");
  }

  // 局限与展望段经常相邻，同时命中时一并保留，后续由专项规则细分。
  if (/未来研究|后续研究/.test(text) && /局限|不足/.test(text)) {
    roleTags.add("limitations");
    roleTags.add("futureWork");
  }

  return Array.from(roleTags);
}
