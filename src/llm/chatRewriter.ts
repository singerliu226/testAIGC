import type OpenAI from "openai";
import type { AppLogger } from "../logger/index.js";
import type { FindingSignal } from "../report/schema.js";
import {
  chatJson,
  createDashscopeClient,
  loadDashscopeConfigFromEnv,
} from "./client.js";

/**
 * 聊天式改写的输出——AI 同时给出自然语言回复和完整改写段落。
 *
 * 设计原因：
 * 用户通过对话给出模糊指令（"改得口语化"/"保留例子"），需要 AI 既像聊天伙伴一样解释做了什么，
 * 又产出一段可直接回写 docx 的 revisedText，供前端一键应用。
 */
export type ChatRewriteOutput = {
  /** 面向用户的自然语言回复（解释改了什么、为什么这样改） */
  reply: string;
  /** 完整的改写后段落文本，用户可一键应用到文档 */
  revisedText: string;
};

export type ChatRewriteParams = {
  logger: AppLogger;
  /** 目标段落原始文本 */
  paragraphText: string;
  /** 段落在文档中的序号 */
  paragraphIndex: number;
  /** 前一段文本（提供上下文衔接） */
  contextBefore?: string;
  /** 后一段文本（提供上下文衔接） */
  contextAfter?: string;
  /** 该段落触发的 AIGC 信号 */
  signals: FindingSignal[];
  /** 已有对话历史（本段落范围内） */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** 本次用户消息 */
  userMessage: string;
};

const SYSTEM_PROMPT = [
  "你是「论文盾」的学术写作修订助手。用户会针对论文中的某个段落，用自然语言给出修改指令。",
  "",
  "你的任务：",
  "1) 根据用户指令改写该段落，使其更像人类写作、降低 AIGC 检测风险，同时不改变原意。",
  "2) 用简短自然语言向用户解释你做了哪些修改、为什么这样改（放在 reply 字段）。",
  "",
  "铁则（不可违反）：",
  "- 不新增不可验证的事实；不捏造引用/数据；不改变关键术语、专有名词、数值。",
  "- 如果原文含有引用标记（如 [1]、（作者，年份）），保持其存在与位置尽量一致。",
  "- 如果用户只是提问而未要求改写（比如'这段为什么被标记？'），reply 中正常回答即可，revisedText 填原文不变。",
  "",
  "输出格式（严格 JSON，不要输出额外文字）：",
  '{ "reply": "面向用户的简短说明", "revisedText": "完整改写后的段落文本" }',
].join("\n");

/**
 * 构建聊天式改写的 messages 数组。
 *
 * 结构：system → 段落上下文（作为首条 user 消息的前置信息） → 历史对话轮次 → 本条 user 消息。
 * 段落上下文和信号作为"背景信息"放在第一条 user 消息中，让模型知道在改什么、有什么风险信号，
 * 但不占用后续对话轮次，避免上下文膨胀。
 */
function buildChatRewriteMessages(
  p: ChatRewriteParams
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const signalSummary = p.signals
    .slice(0, 6)
    .map((s) => `- [${s.category}] ${s.title}：${(s.evidence || []).join("；")} → 建议：${s.suggestion}`)
    .join("\n");

  const contextBlock = [
    "=== 段落上下文 ===",
    p.contextBefore ? `【前一段】${p.contextBefore.slice(0, 200)}` : "",
    `【目标段落 #${p.paragraphIndex}】${p.paragraphText}`,
    p.contextAfter ? `【后一段】${p.contextAfter.slice(0, 200)}` : "",
    signalSummary ? `\n=== 已触发的 AIGC 风险信号 ===\n${signalSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: contextBlock },
    {
      role: "assistant",
      content: JSON.stringify({
        reply: `收到，我已了解第 ${p.paragraphIndex} 段的内容和风险信号。请告诉我你希望怎么修改？`,
        revisedText: p.paragraphText,
      }),
    },
  ];

  for (const h of p.history) {
    messages.push({ role: h.role, content: h.content });
  }

  messages.push({ role: "user", content: p.userMessage });

  return messages;
}

/**
 * 调用 DashScope 进行聊天式改写。
 *
 * 与 `rewriteParagraphWithDashscope` 的区别：
 * - 支持多轮对话历史，用户可反复调优；
 * - 输出同时包含自然语言解释（reply）和可应用的改写文本（revisedText）。
 */
export async function chatRewrite(
  params: ChatRewriteParams
): Promise<ChatRewriteOutput> {
  const cfg = loadDashscopeConfigFromEnv();
  const client = createDashscopeClient(cfg);

  const messages = buildChatRewriteMessages(params);

  const { json } = await chatJson<ChatRewriteOutput>({
    logger: params.logger,
    client,
    model: cfg.model,
    purpose: "chat.rewrite",
    temperature: 0.3,
    messages,
  });

  return {
    reply: typeof json?.reply === "string" ? json.reply : "已完成改写。",
    revisedText:
      typeof json?.revisedText === "string"
        ? json.revisedText
        : params.paragraphText,
  };
}
