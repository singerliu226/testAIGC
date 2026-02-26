import {
  ABSTRACT_NOUNS,
  AI_OPENING_PATTERNS,
  COGNITIVE_MARKERS,
  CONNECTIVES,
  HOLLOW_CONCLUSION_PATTERNS,
  PRONOUNS,
  STRONG_CLAIM_WORDS,
  SYMMETRIC_PATTERNS,
  TEMPLATE_PHRASES,
} from "./lexicons.js";
import {
  clamp,
  countOccurrences,
  mean,
  ngramRepeatRatio,
  splitSentences,
  tokenizeZh,
  variance,
} from "./textUtils.js";

export type ParagraphFeatures = {
  charCount: number;
  sentenceCount: number;
  sentenceLenMean: number;
  sentenceLenVariance: number;

  tokenCount: number;
  tokenUniqueRatio: number;
  bigramRepeatRatio: number;
  trigramRepeatRatio: number;

  templatePhraseCount: number;
  templatePhraseHits: string[];

  connectiveCount: number;
  connectiveHits: string[];

  strongClaimCount: number;
  strongClaimHits: string[];

  abstractNounCount: number;
  abstractNounHits: string[];

  pronounCount: number;
  pronounHits: string[];

  numberTokenCount: number;
  hasCitationMarker: boolean;
  /** 引用标记数量（用于按比例评分） */
  citationMarkerCount: number;

  /** 是否命中 AI 典型段首句式 */
  aiOpeningMatch: boolean;
  /** 命中的段首模式片段（取前 30 字） */
  aiOpeningHit: string;

  /** 是否命中对称结构 */
  symmetricMatch: boolean;
  symmetricHit: string;

  /** 是否命中空洞总结句 */
  hollowConclusionMatch: boolean;
  hollowConclusionHit: string;

  // ── P2 新增特征 ──

  /** 认知特征密度：每千字认知标记数 */
  cognitiveMarkerCount: number;
  cognitiveMarkerHits: string[];
  cognitiveMarkerDensity: number;

  /** 句长分布熵（越高越像人类写作，AI 文本趋近均匀分布导致熵低） */
  sentenceLenEntropy: number;

  /** 连接词段首占比（AI 倾向在段首使用连接词，人类分布更随机） */
  connectiveAtHeadRatio: number;

  /**
   * 段落内部结构变化率：
   * 检测段落内是否存在"论证→反思→修正"的多阶段思维模式。
   * 通过统计段内句子在「陈述/转折/总结」三种功能间的切换次数来衡量。
   */
  internalStructureShifts: number;
};

/**
 * 提取段落特征——统计量 + 词典命中 + 正则模式匹配。
 *
 * 特征必须足够稳定：同一段落多次检测结果应一致，避免用户无法复现。
 */
export function extractFeatures(paragraphText: string): ParagraphFeatures {
  const text = paragraphText ?? "";
  const charCount = text.length;

  const sentences = splitSentences(text);
  const sentenceLens = sentences.map((s) => s.length);

  const tokens = tokenizeZh(text);
  const tokenCount = tokens.length;
  const uniq = new Set(tokens).size;
  const tokenUniqueRatio = tokenCount ? clamp(uniq / tokenCount, 0, 1) : 0;

  const { count: templatePhraseCount, hits: templatePhraseHits } = countOccurrences(
    text,
    TEMPLATE_PHRASES
  );
  const { count: connectiveCount, hits: connectiveHits } = countOccurrences(text, CONNECTIVES);
  const { count: strongClaimCount, hits: strongClaimHits } = countOccurrences(text, STRONG_CLAIM_WORDS);
  const { count: abstractNounCount, hits: abstractNounHits } = countOccurrences(text, ABSTRACT_NOUNS);
  const { count: pronounCount, hits: pronounHits } = countOccurrences(text, PRONOUNS);

  const numberTokenCount = (text.match(/[0-9０-９]+/g) ?? []).length;

  const citationMatches = text.match(/\[[0-9]+\]/g) ?? [];
  const hasCitationMarker =
    citationMatches.length > 0 ||
    /（[^（）]{0,20}\d{4}[^（）]{0,20}）/.test(text) ||
    /\([A-Z][A-Za-z]+,\s*\d{4}\)/.test(text);
  const citationMarkerCount =
    citationMatches.length +
    ((text.match(/（[^（）]{0,20}\d{4}[^（）]{0,20}）/g) ?? []).length) +
    ((text.match(/\([A-Z][A-Za-z]+,\s*\d{4}\)/g) ?? []).length);

  // AI 段首句式匹配（只看段落前 40 字符）
  const head = text.trim().slice(0, 40);
  let aiOpeningMatch = false;
  let aiOpeningHit = "";
  for (const pat of AI_OPENING_PATTERNS) {
    const m = head.match(pat);
    if (m) {
      aiOpeningMatch = true;
      aiOpeningHit = m[0];
      break;
    }
  }

  // 对称结构匹配
  let symmetricMatch = false;
  let symmetricHit = "";
  for (const pat of SYMMETRIC_PATTERNS) {
    const m = text.match(pat);
    if (m) {
      symmetricMatch = true;
      symmetricHit = m[0].length > 40 ? m[0].slice(0, 40) + "…" : m[0];
      break;
    }
  }

  // 空洞总结句匹配（检查段落尾部 80 字符）
  const tail = text.trim().slice(-80);
  let hollowConclusionMatch = false;
  let hollowConclusionHit = "";
  for (const pat of HOLLOW_CONCLUSION_PATTERNS) {
    const m = tail.match(pat);
    if (m) {
      hollowConclusionMatch = true;
      hollowConclusionHit = m[0];
      break;
    }
  }

  // ── P2 新增特征计算 ──

  // 1. 认知特征密度
  const { count: cognitiveMarkerCount, hits: cognitiveMarkerHits } =
    countOccurrences(text, COGNITIVE_MARKERS);
  const cognitiveMarkerDensity =
    charCount > 0 ? (cognitiveMarkerCount / charCount) * 1000 : 0;

  // 2. 句长分布熵（信息熵）
  //    人类写作句长分布不均匀 → 熵高；AI 写作句长均匀 → 熵低。
  let sentenceLenEntropy = 0;
  if (sentences.length >= 2) {
    const totalLen = sentenceLens.reduce((a, b) => a + b, 0);
    if (totalLen > 0) {
      for (const l of sentenceLens) {
        const p = l / totalLen;
        if (p > 0) sentenceLenEntropy -= p * Math.log2(p);
      }
    }
  }

  // 3. 连接词段首占比
  //    AI 几乎总在句首放连接词；人类也会在句中使用。
  let connectivesAtHead = 0;
  for (const s of sentences) {
    const trimmed = s.trim();
    for (const c of CONNECTIVES) {
      if (trimmed.startsWith(c)) {
        connectivesAtHead++;
        break;
      }
    }
  }
  const connectiveAtHeadRatio =
    connectiveCount > 0 ? connectivesAtHead / connectiveCount : 0;

  // 4. 段落内部结构变化率
  //    将每句分类为 陈述(S)/转折(T)/总结(C) 三种功能，统计相邻句功能切换次数。
  const TURN_WORDS = ["但是", "然而", "不过", "可是", "尽管", "虽然", "但", "却"];
  const SUMM_WORDS = ["因此", "所以", "由此可见", "综上", "总之", "可见", "总的来说", "换言之"];
  function classifySentence(sent: string): "S" | "T" | "C" {
    const h = sent.trim();
    for (const w of TURN_WORDS) { if (h.startsWith(w)) return "T"; }
    for (const w of SUMM_WORDS) { if (h.startsWith(w)) return "C"; }
    return "S";
  }
  let internalStructureShifts = 0;
  if (sentences.length >= 2) {
    let prev = classifySentence(sentences[0]);
    for (let si = 1; si < sentences.length; si++) {
      const cur = classifySentence(sentences[si]);
      if (cur !== prev) internalStructureShifts++;
      prev = cur;
    }
  }

  return {
    charCount,
    sentenceCount: sentences.length,
    sentenceLenMean: mean(sentenceLens),
    sentenceLenVariance: variance(sentenceLens),

    tokenCount,
    tokenUniqueRatio,
    bigramRepeatRatio: ngramRepeatRatio(tokens, 2),
    trigramRepeatRatio: ngramRepeatRatio(tokens, 3),

    templatePhraseCount,
    templatePhraseHits,

    connectiveCount,
    connectiveHits,

    strongClaimCount,
    strongClaimHits,

    abstractNounCount,
    abstractNounHits,

    pronounCount,
    pronounHits,

    numberTokenCount,
    hasCitationMarker,
    citationMarkerCount,

    aiOpeningMatch,
    aiOpeningHit,
    symmetricMatch,
    symmetricHit,
    hollowConclusionMatch,
    hollowConclusionHit,

    cognitiveMarkerCount,
    cognitiveMarkerHits,
    cognitiveMarkerDensity,
    sentenceLenEntropy,
    connectiveAtHeadRatio,
    internalStructureShifts,
  };
}
