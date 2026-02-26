import OpenAI from "openai";
import type { AppLogger } from "../logger/index.js";

export type DashscopeConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
};

export function loadDashscopeConfigFromEnv(): DashscopeConfig {
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim() ?? "";
  const baseURL =
    (process.env.DASHSCOPE_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(
      /\/+$/,
      ""
    );
  const model = process.env.DASHSCOPE_MODEL?.trim() || "qwen-plus-latest";

  if (!apiKey) {
    throw new Error(
      "Missing DASHSCOPE_API_KEY. Please set it in your environment (see .env.example)."
    );
  }

  return { apiKey, baseURL, model };
}

/**
 * 创建阿里云 OpenAI 兼容客户端（DashScope）。
 *
 * 设计原因：
 * - 阿里云提供 OpenAI 兼容端点，可直接复用成熟的 OpenAI SDK；
 * - 我们通过 `baseURL/model` 可配置，方便你在不同地域/不同模型间切换（qwen-plus/flash/max 等）。
 */
export function createDashscopeClient(cfg: DashscopeConfig): OpenAI {
  return new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
}

export type ChatJsonOptions = {
  logger: AppLogger;
  client: OpenAI;
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  temperature?: number;
  maxTokens?: number;
  /**
   * 用于日志追踪（不写正文）：例如 `rewrite.paragraph` / `judge.paragraph`。
   */
  purpose: string;
};

/**
 * 调用 Chat Completions 并尽量返回可解析 JSON。
 *
 * 设计原因：
 * - 我们需要结构化输出（revisedText、rationale、resolvedSignals...），否则 UI 与回写很难稳定对接；
 * - 不同兼容端点对 `response_format` 的支持不一致，因此需要“先尝试、再降级”。
 *
 * 实现方式：
 * - 优先尝试 `response_format: { type: 'json_object' }`；失败则降级为“强约束提示 + 提取 JSON 子串”。
 */
export async function chatJson<T>(opts: ChatJsonOptions): Promise<{ rawText: string; json: T }> {
  const t0 = Date.now();
  const log = opts.logger;

  const basePayload: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    // max_tokens 在部分兼容端点可用；若不支持会报错，我们会走降级分支
    max_tokens: opts.maxTokens,
  };

  // 1) 尝试 response_format
  try {
    const resp = await opts.client.chat.completions.create({
      ...basePayload,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response_format: { type: "json_object" } as any,
    });
    const rawText = resp.choices?.[0]?.message?.content ?? "";
    const json = safeParseJson<T>(rawText);
    log.info("LLM chatJson ok", {
      purpose: opts.purpose,
      ms: Date.now() - t0,
      usage: resp.usage,
    });
    return { rawText, json };
  } catch (err) {
    log.warn("LLM chatJson response_format failed; fallback", {
      purpose: opts.purpose,
      ms: Date.now() - t0,
      error: err instanceof Error ? { name: err.name, message: err.message } : { err },
    });
  }

  // 2) 降级：不带 response_format，但强制提示输出 JSON
  const resp2 = await opts.client.chat.completions.create(basePayload);
  const rawText2 = resp2.choices?.[0]?.message?.content ?? "";
  const json2 = safeParseJson<T>(rawText2);
  log.info("LLM chatJson ok (fallback)", {
    purpose: opts.purpose,
    ms: Date.now() - t0,
    usage: resp2.usage,
  });
  return { rawText: rawText2, json: json2 };
}

function safeParseJson<T>(raw: string): T {
  // 允许模型输出前后带少量解释文本，尽量提取最外层 JSON 对象
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const obj = extractFirstJsonObject(trimmed);
    return JSON.parse(obj) as T;
  }
}

function extractFirstJsonObject(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("LLM output is not valid JSON");
  }
  return text.slice(first, last + 1);
}

