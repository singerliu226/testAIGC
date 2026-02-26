import type { DocxParagraph } from "../docx/documentXml.js";
import type { DocumentReport, FindingSignal, ParagraphReport, RiskLevel } from "../report/schema.js";
import { extractFeatures } from "./features.js";
import { clamp, tokenizeZh, unique } from "./textUtils.js";

function riskLevel(score: number): RiskLevel {
  if (score >= 70) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/** 取排序后第 p 百分位的值（p 取 0-1） */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

/**
 * 信号叠加加分：多条信号同时命中时额外加分。
 *
 * 设计原因：单条信号可能误报，但 3+ 条同时命中则置信度大幅上升。
 */
function synergyBonus(signals: FindingSignal[]): number {
  const n = signals.length;
  const categories = new Set(signals.map((s) => s.category));

  let bonus = 0;
  if (n >= 5) bonus = 25;
  else if (n >= 4) bonus = 18;
  else if (n >= 3) bonus = 10;

  if (categories.size >= 3) bonus += 8;

  return bonus;
}

/**
 * 检测相邻段落是否呈现句式同构（相同的开头模式或连接词序列）。
 *
 * 返回命中同构的段落索引集合。
 */
function detectStructuralIsomorphism(
  paragraphs: Array<{ text: string; index: number }>,
): Set<number> {
  const isomorphicIndices = new Set<number>();
  if (paragraphs.length < 3) return isomorphicIndices;

  for (let i = 0; i <= paragraphs.length - 3; i++) {
    const heads = [i, i + 1, i + 2].map((j) => {
      const t = paragraphs[j].text.trim();
      // 提取段首关键词（前 4 个字）
      return t.slice(0, 4);
    });

    // 连续 3 段以相同 2 字开头
    const prefix2 = heads.map((h) => h.slice(0, 2));
    if (prefix2[0] === prefix2[1] && prefix2[1] === prefix2[2] && prefix2[0].length >= 2) {
      isomorphicIndices.add(paragraphs[i].index);
      isomorphicIndices.add(paragraphs[i + 1].index);
      isomorphicIndices.add(paragraphs[i + 2].index);
      continue;
    }

    // 连续 3 段都含"首先/其次/再次/此外"等相同套路连接词序列
    const connSet = ["首先", "其次", "再次", "最后", "此外", "同时", "另外"];
    const connCounts = [i, i + 1, i + 2].map((j) => {
      let c = 0;
      for (const w of connSet) if (paragraphs[j].text.includes(w)) c++;
      return c;
    });
    if (connCounts.every((c) => c >= 2)) {
      isomorphicIndices.add(paragraphs[i].index);
      isomorphicIndices.add(paragraphs[i + 1].index);
      isomorphicIndices.add(paragraphs[i + 2].index);
    }
  }

  return isomorphicIndices;
}

/**
 * 文档级 AIGC 风险检测（规则 + 统计特征 + 正则模式 + 信号叠加 + 加权评分）。
 *
 * 设计原则：
 * - 宁可偏严不可偏松——面向毕业论文查重场景，漏报比误报危害更大；
 * - 段落级信号可解释，附带可执行的修改建议；
 * - 文档级评分突出高风险段落的贡献，避免大量低风险段落稀释整体分。
 */
export function detectAigcRisk(paragraphs: Array<Pick<DocxParagraph, "id" | "index" | "kind" | "text">>): DocumentReport {
  const perParaTokens = paragraphs.map((p) => {
    const tokens = tokenizeZh(p.text).filter((t) => t.length > 1);
    return new Set(tokens);
  });

  // 段落间句式同构检测
  const isomorphicSet = detectStructuralIsomorphism(
    paragraphs.map((p) => ({ text: p.text, index: p.index }))
  );

  const paragraphReports: ParagraphReport[] = paragraphs.map((p, i) => {
    const f = extractFeatures(p.text);
    const signals: FindingSignal[] = [];

    // ───── 1) languageStats ─────

    if (f.sentenceCount >= 2 && f.sentenceLenVariance < 35 && f.charCount >= 60) {
      signals.push({
        signalId: "lang_uniform_sentence",
        category: "languageStats",
        title: "句子长度过于均匀（文本节奏很「平」）",
        evidence: [
          `句子数=${f.sentenceCount}`,
          `句长方差≈${f.sentenceLenVariance.toFixed(1)}`,
        ],
        suggestion: "把长句拆成有信息增量的短句，或在关键处加入限定条件/例子/反例，让段落节奏自然波动。",
        score: 15,
      });
    }

    if (f.bigramRepeatRatio > 0.06 || f.trigramRepeatRatio > 0.03) {
      signals.push({
        signalId: "lang_ngram_repeat",
        category: "languageStats",
        title: "局部措辞/结构重复偏多",
        evidence: [
          `bigram重复≈${(f.bigramRepeatRatio * 100).toFixed(1)}%`,
          `trigram重复≈${(f.trigramRepeatRatio * 100).toFixed(1)}%`,
        ],
        suggestion: "删除重复表达；对并列句改为「观点→理由→证据」的链条表达，避免句式模板反复出现。",
        score: 16,
      });
    }

    if (f.tokenCount >= 15 && f.tokenUniqueRatio < 0.55) {
      signals.push({
        signalId: "lang_low_diversity",
        category: "languageStats",
        title: "用词多样性偏低（重复词较多）",
        evidence: [
          `词汇多样性≈${(f.tokenUniqueRatio * 100).toFixed(1)}%`,
        ],
        suggestion: "减少抽象复述，替换为可核验信息（时间/对象/方法/边界条件）；引入你自己的表述习惯。",
        score: 12,
      });
    }

    // ───── 2) styleHabits ─────

    if (f.templatePhraseCount >= 1) {
      signals.push({
        signalId: "style_template_phrases",
        category: "styleHabits",
        title: "套话/模板句偏多",
        evidence: [
          `命中模板短语：${unique(f.templatePhraseHits).join("、") || "（未列出）"}`,
          `命中${f.templatePhraseCount}处`,
        ],
        suggestion: "删掉不承载信息的句子；把「总结性套话」改成具体结论 + 依据 + 适用范围。",
        score: 18,
      });
    }

    const connPer100 = f.charCount ? (f.connectiveCount / f.charCount) * 100 : 0;
    if (f.connectiveCount >= 2 && connPer100 >= 0.8) {
      signals.push({
        signalId: "style_connectives_dense",
        category: "styleHabits",
        title: "连接词密度偏高（行文过度工整）",
        evidence: [
          `连接词：${unique(f.connectiveHits).join("、") || "（未列出）"}`,
          `每百字≈${connPer100.toFixed(1)}个`,
        ],
        suggestion: "减少显式连接词，改为更自然的段内推进：每句只承担一个信息点，用指代和因果自然衔接。",
        score: 14,
      });
    }

    if (f.abstractNounCount >= 2 && f.charCount >= 40) {
      signals.push({
        signalId: "style_abstract_dense",
        category: "styleHabits",
        title: "抽象名词堆叠（信息增量不足）",
        evidence: [
          `命中：${unique(f.abstractNounHits).join("、") || "（未列出）"}`,
          `共${f.abstractNounCount}处`,
        ],
        suggestion: "把抽象词后面补上具体说明——是什么/怎么衡量/用什么例子说明。",
        score: 12,
      });
    }

    // ───── 3) logicCoherence ─────

    if (f.pronounCount >= 3 && f.charCount >= 40) {
      signals.push({
        signalId: "logic_pronoun_dense",
        category: "logicCoherence",
        title: "指代词偏多（读者可能不知道「这/其/该」指什么）",
        evidence: [
          `命中：${unique(f.pronounHits).join("、") || "（未列出）"}`,
          `共${f.pronounCount}处`,
        ],
        suggestion: "把关键指代替换成明确实体（研究对象/变量/结论名）。",
        score: 10,
      });
    }

    // 主题漂移（相邻段落 Jaccard）
    const prev = i > 0 ? perParaTokens[i - 1] : undefined;
    const next = i + 1 < perParaTokens.length ? perParaTokens[i + 1] : undefined;
    const cur = perParaTokens[i];
    const simPrev = prev ? jaccard(prev, cur) : 1;
    const simNext = next ? jaccard(cur, next) : 1;
    const minSim = Math.min(simPrev, simNext);
    if (f.charCount >= 50 && minSim < 0.08) {
      signals.push({
        signalId: "logic_topic_shift",
        category: "logicCoherence",
        title: "与相邻段落主题衔接偏弱（疑似拼接/跳跃）",
        evidence: [
          `与上一段相似度≈${simPrev.toFixed(2)}`,
          `与下一段相似度≈${simNext.toFixed(2)}`,
        ],
        suggestion: "在段首补一句承接句（指出上一段结论与本段关系），段尾写清引出下一段的逻辑。",
        score: 12,
      });
    }

    // ───── 4) verifiability ─────

    // 按比例评分：强断言占比高且引用少
    const claimRatio = f.sentenceCount > 0 ? f.strongClaimCount / f.sentenceCount : 0;
    if (claimRatio > 0.3 && f.citationMarkerCount <= 1) {
      signals.push({
        signalId: "veri_strong_claim_no_cite",
        category: "verifiability",
        title: "强断言较多但缺少可核验支撑",
        evidence: [
          `强断言：${unique(f.strongClaimHits).join("、") || "（未列出）"}`,
          `断言占比≈${(claimRatio * 100).toFixed(0)}%`,
          `引用标记仅${f.citationMarkerCount}处`,
        ],
        suggestion: "把结论句后面补上证据来源（引用/数据/实验）+ 适用范围；若无法支撑，弱化措辞。",
        score: 18,
      });
    } else if (f.strongClaimCount >= 1 && !f.hasCitationMarker) {
      signals.push({
        signalId: "veri_claim_no_cite_weak",
        category: "verifiability",
        title: "存在断言但缺少引用支撑",
        evidence: [
          `强断言：${unique(f.strongClaimHits).join("、") || "（未列出）"}`,
          `引用标记：无`,
        ],
        suggestion: "为关键结论补上文献来源或数据依据。",
        score: 12,
      });
    }

    // 引用与断言比例失衡（3+ 强断言但 0-1 引用）
    if (f.strongClaimCount >= 3 && f.citationMarkerCount <= 1) {
      signals.push({
        signalId: "veri_cite_imbalance",
        category: "verifiability",
        title: "引用与断言数量严重失衡",
        evidence: [
          `强断言${f.strongClaimCount}处，引用仅${f.citationMarkerCount}处`,
        ],
        suggestion: "每个核心断言至少对应一个可核验来源（文献/数据/实证）。",
        score: 16,
      });
    }

    // ───── 5) structureFormat ─────

    if (/^(首先|其次|再次|最后)[，,、]/.test(p.text.trim()) && f.connectiveCount >= 2) {
      signals.push({
        signalId: "struct_list_like",
        category: "structureFormat",
        title: "段落呈现「罗列式模板结构」",
        evidence: [
          `段首：${p.text.trim().slice(0, 12)}`,
          `连接词${f.connectiveCount}处`,
        ],
        suggestion: "把罗列改为：先给结论，再按重要性展开 1-2 个关键理由。",
        score: 12,
      });
    }

    // ───── 6) aiPattern（新维度） ─────

    // 段首典型 AI 句式
    if (f.aiOpeningMatch) {
      signals.push({
        signalId: "ai_opening_pattern",
        category: "aiPattern",
        title: "段首使用了 AI 典型开头句式",
        evidence: [`匹配："${f.aiOpeningHit}"`],
        suggestion: "删除或改写段首套话，直接从你要论述的核心观点开始。",
        score: 14,
      });
    }

    // 对称结构
    if (f.symmetricMatch) {
      signals.push({
        signalId: "ai_symmetric_structure",
        category: "aiPattern",
        title: "使用了 AI 偏爱的对称句式",
        evidence: [`匹配："${f.symmetricHit}"`],
        suggestion: "打破对称结构，改为侧重论述更重要的一方，或用因果链替代并列。",
        score: 10,
      });
    }

    // 空洞总结句
    if (f.hollowConclusionMatch) {
      signals.push({
        signalId: "ai_hollow_conclusion",
        category: "aiPattern",
        title: "段尾存在无信息增量的空洞总结",
        evidence: [`匹配："${f.hollowConclusionHit}"`],
        suggestion: "删除空洞总结，或替换为本段的具体结论 + 下一步推论。",
        score: 12,
      });
    }

    // 长段落均质性（>200 字且句长方差和词汇多样性同时偏低）
    if (f.charCount >= 200 && f.sentenceLenVariance < 40 && f.tokenUniqueRatio < 0.50) {
      signals.push({
        signalId: "ai_long_homogeneous",
        category: "aiPattern",
        title: "长段落行文过于均质（缺乏人类写作的自然波动）",
        evidence: [
          `段落${f.charCount}字`,
          `句长方差≈${f.sentenceLenVariance.toFixed(1)}`,
          `词汇多样性≈${(f.tokenUniqueRatio * 100).toFixed(1)}%`,
        ],
        suggestion: "在长段落中穿插短句、反问或具体例子，打破机械般的均匀行文。",
        score: 10,
      });
    }

    // ───── 7) cognitiveFeatures（P2 新增维度） ─────

    // 认知特征密度过低（AI 文本典型特征）
    // 人类论文约每千字 4.2 处认知标记，AI 仅 0.7 处
    if (f.charCount >= 80 && f.cognitiveMarkerDensity < 1.5) {
      signals.push({
        signalId: "cog_low_density",
        category: "cognitiveFeatures",
        title: "认知特征密度过低（缺乏人类思维痕迹）",
        evidence: [
          `认知标记${f.cognitiveMarkerCount}处`,
          `密度≈${f.cognitiveMarkerDensity.toFixed(1)}/千字（人类平均≈4.2/千字）`,
        ],
        suggestion: "在论证过程中加入思维转折（「然而笔者发现」「这一发现与预期不同」）、研究者视角评论（「从实践经验来看」「在调研中注意到」），体现真实研究过程。",
        score: 14,
      });
    }

    // 句长分布熵过低（AI 文本句长均匀 → 熵低）
    // 对 3+ 句的段落检测；人类写作熵值通常 > 2.5
    if (f.sentenceCount >= 3 && f.sentenceLenEntropy < 2.2) {
      signals.push({
        signalId: "cog_low_entropy",
        category: "cognitiveFeatures",
        title: "句长分布熵偏低（节奏过于机械）",
        evidence: [
          `句长熵≈${f.sentenceLenEntropy.toFixed(2)}（人类写作通常>2.5）`,
          `共${f.sentenceCount}个句子`,
        ],
        suggestion: "刻意混合短句（<15字）和长句（>40字）：在连续长句后插入简短总结句，在短句后展开详细论述。",
        score: 12,
      });
    }

    // 连接词全部位于段首（AI 偏好）
    if (f.connectiveCount >= 2 && f.connectiveAtHeadRatio >= 0.9) {
      signals.push({
        signalId: "cog_connective_head_only",
        category: "cognitiveFeatures",
        title: "连接词全部位于句首（位置缺乏多样性）",
        evidence: [
          `${f.connectiveCount}个连接词中${Math.round(f.connectiveAtHeadRatio * 100)}%在句首`,
        ],
        suggestion: "尝试将部分连接词移至句中或删除，用因果关系和指代自然衔接，如「这一现象，从另一角度看，也反映了...」。",
        score: 10,
      });
    }

    // 段落内部结构缺乏变化（长段落全部是陈述句，无转折和总结切换）
    if (f.sentenceCount >= 4 && f.internalStructureShifts === 0) {
      signals.push({
        signalId: "cog_flat_structure",
        category: "cognitiveFeatures",
        title: "段落内部论证结构单一（缺乏「论证→反思→修正」的思维模式）",
        evidence: [
          `${f.sentenceCount}个句子全部为陈述句，未见功能切换`,
        ],
        suggestion: "在段落中加入转折句（「但需要注意的是」「这一结论也存在局限」）或追问句，打破单一陈述流。",
        score: 10,
      });
    }

    // 段落间句式同构
    if (isomorphicSet.has(p.index)) {
      signals.push({
        signalId: "ai_structural_isomorphism",
        category: "aiPattern",
        title: "与相邻段落呈现句式同构（结构重复）",
        evidence: ["连续 3+ 段使用相似的开头或连接词序列"],
        suggestion: "变换段落的开头方式和论证结构，避免每段都是相同的「论点-论据-总结」模式。",
        score: 12,
      });
    }

    // ───── 计算段落风险分（含叠加加分） ─────

    const baseScore = signals.reduce((a, s) => a + s.score, 0);
    const bonus = synergyBonus(signals);
    const riskScore = clamp(baseScore + bonus, 0, 100);

    return {
      paragraphId: p.id,
      index: p.index,
      kind: p.kind,
      text: p.text,
      riskScore,
      riskLevel: riskLevel(riskScore),
      signals,
    };
  });

  // ───── 文档级评分：对齐知网/万方/维普行业标准 ─────
  // AI率 = Σ(段落字符数 × 段落AI概率) / Σ(段落字符数)
  // 段落AI概率：riskScore >= 35 的段落按其 riskScore/100 计入，
  // 低于 35 的视为非AI生成（概率为 0），与知网"疑似/非疑似"二分逻辑一致。

  let aiCharCount = 0;
  let totalCharCount = 0;
  for (const r of paragraphReports) {
    const charLen = r.text.length;
    totalCharCount += charLen;
    if (r.riskScore >= 35) {
      aiCharCount += charLen * (r.riskScore / 100);
    }
  }
  const overallRiskScore = totalCharCount > 0
    ? clamp(Math.round((aiCharCount / totalCharCount) * 100), 0, 100)
    : 0;

  return {
    generatedAt: Date.now(),
    overallRiskScore,
    overallRiskLevel: riskLevel(overallRiskScore),
    paragraphReports,
    limitations: [
      "该检测是「风险提示」而非定性证据：高分不等于一定使用了AI，低分也不等于一定未使用AI。",
      "模板化学术写作、反复润色、母语非中文写作等场景可能导致误报；深度人工改写也可能导致漏报。",
      "本工具不会联网核验事实与引用真伪；请对关键结论、数据与引用来源做人工复核。",
    ],
  };
}
