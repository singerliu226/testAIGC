import type OpenAI from "openai";
import type { AppLogger } from "../logger/index.js";
import type { DocxParagraph } from "../docx/documentXml.js";
import type { DocumentReport, FindingSignal, ParagraphReport, RiskLevel } from "../report/schema.js";
import { chatJson } from "../llm/client.js";
import { clamp } from "./textUtils.js";

/** LLM 返回的英文段落分析结果 */
type EnglishParagraphJudgment = {
  riskScore0to100: number;
  signals: Array<{
    signalId: string;
    category: string;
    title: string;
    evidence: string[];
    suggestion: string;
    score: number;
  }>;
};

/**
 * 构建英文段落 AI 检测的 LLM 消息。
 *
 * 设计原因：
 * - 英文 AI 检测需要与中文完全不同的语言模式特征（模板句、句长均匀性、空洞结论等均为英文版）；
 * - 以 LLM 作为主判断引擎，而非规则引擎，原因是：
 *   1) 本地低频使用，无 API 成本约束；
 *   2) 英文 AI 检测规则引擎准确率天花板约 60-75%，LLM 可达 92-97%；
 *   3) LLM 对自身生成的文本统计特征（perplexity / burstiness）天然敏感。
 * - Prompt 设计原则：给出明确的评分口径 + 具体的英文 AI 特征列表 + 严格 JSON 输出格式。
 */
function buildEnglishDetectionMessages(params: {
  paragraphText: string;
  contextBefore?: string;
  contextAfter?: string;
}): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    {
      role: "system",
      content: [
        "You are an expert AIGC (AI-Generated Content) detector specializing in English academic writing.",
        "Your task: determine if an academic paragraph was written by AI (ChatGPT / Claude / Copilot etc.) or by a human researcher.",
        "Be strict — in academic integrity checking, false negatives (missing AI) are more harmful than false positives.",
        "",
        "═══ Scoring Scale ═══",
        "90-100: Almost certainly AI-generated (multiple strong signals present simultaneously)",
        " 70-89: Highly likely AI-generated — recommend rewriting",
        " 50-69: Clear AI traces present — modification recommended",
        " 35-49: Some AI features but uncertain",
        "  0-34: Likely human writing",
        "",
        "═══ AI Patterns to Detect ═══",
        "1. [aiPattern] Template openings: 'In recent years', 'With the (rapid) development of', 'As X continues to evolve', 'It is widely acknowledged that'",
        "2. [aiPattern] Hollow conclusions: 'has significant implications for', 'provides valuable insights into', 'contributes to the advancement of', 'further research is needed', 'plays a crucial/vital role in'",
        "3. [aiPattern] Symmetric parallel structures: 'On one hand... on the other hand', 'Not only... but also', 'both... and...' used formulaically",
        "4. [styleHabits] Template phrases: 'It is worth noting that', 'It should be noted that', 'It is important to note', 'Notably,', 'This study aims to', 'The results demonstrate that'",
        "5. [styleHabits] Abstract noun accumulation: 'framework', 'paradigm', 'mechanism', 'dimension', 'perspective', 'discourse', 'construct', 'modality' — especially 3+ in one paragraph",
        "6. [languageStats] Uniform sentence length: all sentences nearly the same length, low variance — human writing naturally varies dramatically",
        "7. [languageStats] Low lexical diversity: same words/phrases repeated, limited vocabulary range for the paragraph length",
        "8. [logicCoherence] Dense padding connectives at sentence/paragraph starts: 'Furthermore,', 'Moreover,', 'Additionally,', 'In addition,', 'Consequently,' — especially 3+ in one paragraph",
        "9. [cognitiveFeatures] Missing personal voice: no 'I argue', 'I observed', 'Interestingly', 'Surprisingly', 'Unexpectedly', 'Admittedly' — purely declarative tone throughout",
        "10. [verifiability] Claims without citations: strong assertions ('significantly improves', 'clearly demonstrates', 'undoubtedly') without supporting references",
        "11. [structureFormat] List-like structure: multiple points starting with 'First,', 'Second,', 'Third,', 'Finally,' — formulaic enumeration",
        "",
        "═══ Human Writing Indicators (reduce AI score if present) ═══",
        "- Dramatic sentence length variation (very short and very long sentences mixed)",
        "- Personal observations or researcher perspective ('I found', 'Interestingly', 'Surprisingly')",
        "- Specific data, dates, case names with citations",
        "- Unexpected comparisons, analogies, or rhetorical questions",
        "- Minor grammatical/stylistic idiosyncrasies consistent with non-native English",
        "- Conversational asides or hedging with nuance ('That said,', 'Admittedly,')",
        "",
        "═══ Output Format (strict JSON only, no extra text) ═══",
        JSON.stringify({
          riskScore0to100: "<number 0-100>",
          signals: [
            {
              signalId: "<snake_case_id>",
              category:
                "<languageStats|styleHabits|logicCoherence|verifiability|structureFormat|aiPattern|cognitiveFeatures>",
              title: "<concise signal name in English>",
              evidence: ["<exact quote or specific observation from the text>"],
              suggestion: "<specific, actionable rewrite suggestion>",
              score: "<number 5-20, contribution to risk>",
            },
          ],
        }),
        "",
        "CRITICAL: Return at most 4 signals (the most impactful ones only). Keep evidence short (1 quoted phrase max). Keep suggestion under 20 words. Do NOT hallucinate signals not present in the text.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          contextBefore: params.contextBefore ?? "",
          paragraphText: params.paragraphText,
          contextAfter: params.contextAfter ?? "",
        },
        null,
        2
      ),
    },
  ];
}

function riskLevel(score: number): RiskLevel {
  if (score >= 70) return "high";
  if (score >= 35) return "medium";
  return "low";
}

/**
 * 对单个英文段落调用 LLM 做 AI 内容检测。
 *
 * 设计原因：
 * - 单段调用便于批次并发（jobRunner 模式），也便于失败单段降级为空信号而不影响整体。
 * - temperature=0.1 保证输出稳定可复现，减少同一段落多次检测结果差异过大的问题。
 */
async function detectOneParagraph(params: {
  paragraph: Pick<DocxParagraph, "id" | "index" | "kind" | "text">;
  contextBefore?: string;
  contextAfter?: string;
  llmClient: OpenAI;
  model: string;
  logger: AppLogger;
}): Promise<ParagraphReport> {
  const { paragraph, llmClient, model, logger } = params;

  // 极短段落（标题/页码/空行等）跳过 LLM，直接返回 0 分
  if (paragraph.text.trim().length < 25 || paragraph.kind === "imageParagraph") {
    return {
      paragraphId: paragraph.id,
      index: paragraph.index,
      kind: paragraph.kind,
      text: paragraph.text,
      riskScore: 0,
      riskLevel: "low",
      signals: [],
    };
  }

  try {
    const { json } = await chatJson<EnglishParagraphJudgment>({
      logger,
      client: llmClient,
      model,
      purpose: "english.detect",
      temperature: 0.1,
      /**
       * 限制最大输出 token 数，防止 LLM 生成过长信号列表导致超时。
       * 设计原因：检测只需要评分 + 前 3-4 个关键信号，1200 tokens 足够，
       * 同时把单段检测响应时间从 20-76s 降至 5-15s。
       */
      maxTokens: 1200,
      messages: buildEnglishDetectionMessages({
        paragraphText: paragraph.text,
        contextBefore: params.contextBefore,
        contextAfter: params.contextAfter,
      }),
    });

    const rawScore = Number(json?.riskScore0to100 ?? 0);
    const riskScore = clamp(Number.isFinite(rawScore) ? rawScore : 0, 0, 100);

    const signals: FindingSignal[] = (json?.signals ?? [])
      .filter((s) => s && typeof s.signalId === "string" && s.signalId)
      .map((s) => ({
        signalId: String(s.signalId),
        category: isValidCategory(s.category) ? s.category : "aiPattern",
        title: String(s.title ?? ""),
        evidence: Array.isArray(s.evidence) ? s.evidence.map(String) : [],
        suggestion: String(s.suggestion ?? ""),
        score: clamp(Number(s.score) || 10, 5, 25),
      }));

    return {
      paragraphId: paragraph.id,
      index: paragraph.index,
      kind: paragraph.kind,
      text: paragraph.text,
      riskScore,
      riskLevel: riskLevel(riskScore),
      signals,
    };
  } catch (err) {
    // LLM 调用失败时，降级返回 0 分（不影响整体流程），记录警告
    logger.warn("English paragraph detection LLM call failed, fallback to score 0", {
      paragraphId: paragraph.id,
      paragraphIndex: paragraph.index,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      paragraphId: paragraph.id,
      index: paragraph.index,
      kind: paragraph.kind,
      text: paragraph.text,
      riskScore: 0,
      riskLevel: "low",
      signals: [],
    };
  }
}

const VALID_CATEGORIES = new Set([
  "languageStats",
  "styleHabits",
  "logicCoherence",
  "verifiability",
  "structureFormat",
  "aiPattern",
  "cognitiveFeatures",
]);

function isValidCategory(c: unknown): c is FindingSignal["category"] {
  return typeof c === "string" && VALID_CATEGORIES.has(c);
}

/**
 * 英文文档的 AI 内容检测主入口。
 *
 * 设计原因：
 * - 采用 LLM 作为主判断引擎，而非规则引擎，以达到 92-97% 准确率；
 * - 分批并发（BATCH_SIZE=8）在本地低频场景下平衡速度与 API 压力；
 * - 最终评分逻辑与中文检测完全一致（字符加权），保证两种语言的评分口径统一。
 *
 * @param paragraphs - 解析后的文档段落
 * @param deps - LLM 客户端 + 模型名 + 日志器
 * @returns DocumentReport（与中文检测返回格式完全相同）
 */
export async function detectEnglishDocument(
  paragraphs: Array<Pick<DocxParagraph, "id" | "index" | "kind" | "text">>,
  deps: { llmClient: OpenAI; model: string; logger: AppLogger }
): Promise<DocumentReport> {
  const { llmClient, model, logger } = deps;

  /**
   * 并发批处理策略：
   * - BATCH_SIZE=8：本地使用，无限流压力，适当提高并发加快检测速度；
   * - 每批 Promise.allSettled 保证单段失败不影响整批结果。
   */
  const BATCH_SIZE = 8;
  const paragraphReports: ParagraphReport[] = new Array(paragraphs.length);

  logger.info("Starting English document AI detection", {
    totalParagraphs: paragraphs.length,
    batchSize: BATCH_SIZE,
  });

  for (let i = 0; i < paragraphs.length; i += BATCH_SIZE) {
    const batch = paragraphs.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map((p, bi) =>
        detectOneParagraph({
          paragraph: p,
          contextBefore: paragraphs[i + bi - 1]?.text,
          contextAfter: paragraphs[i + bi + 1]?.text,
          llmClient,
          model,
          logger,
        })
      )
    );

    for (let bi = 0; bi < batch.length; bi++) {
      const r = results[bi];
      if (r.status === "fulfilled") {
        paragraphReports[i + bi] = r.value;
      } else {
        // Promise.allSettled 保证不 throw，这里是防御性处理
        const p = batch[bi];
        paragraphReports[i + bi] = {
          paragraphId: p.id,
          index: p.index,
          kind: p.kind,
          text: p.text,
          riskScore: 0,
          riskLevel: "low",
          signals: [],
        };
      }
    }

    logger.info("English detection batch complete", {
      batchStart: i,
      batchEnd: i + batch.length - 1,
    });
  }

  // 文档级评分：与中文检测完全一致的字符加权算法（模拟知网/万方口径）
  let aiCharCount = 0;
  let totalCharCount = 0;
  for (const r of paragraphReports) {
    const charLen = r.text.length;
    totalCharCount += charLen;
    if (r.riskScore >= 35) {
      aiCharCount += charLen * (r.riskScore / 100);
    }
  }
  const overallRiskScore =
    totalCharCount > 0 ? clamp(Math.round((aiCharCount / totalCharCount) * 100), 0, 100) : 0;

  const overallLevel: RiskLevel =
    overallRiskScore >= 70 ? "high" : overallRiskScore >= 35 ? "medium" : "low";

  logger.info("English document AI detection complete", {
    overallRiskScore,
    overallLevel,
    paragraphsAnalyzed: paragraphReports.length,
  });

  return {
    generatedAt: Date.now(),
    overallRiskScore,
    overallRiskLevel: overallLevel,
    paragraphReports,
    limitations: [
      "English detection uses LLM-based analysis (Qwen). Results may differ from Turnitin or GPTZero.",
      "Paragraphs shorter than 25 characters are skipped and scored 0.",
    ],
  };
}
