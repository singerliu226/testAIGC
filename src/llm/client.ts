import OpenAI from "openai";
import type { AppLogger } from "../logger/index.js";

export type DashscopeConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  /**
   * 单次 LLM 请求超时时间（毫秒）。
   *
   * 设计原因：
   * - 自动降分是长任务，任何一次请求“卡死”都会让用户以为系统无响应；
   * - 超时后由上层将该段落标记为失败并继续处理其它段落，保证整体可交付。
   */
  timeoutMs: number;
};

export function loadDashscopeConfigFromEnv(): DashscopeConfig {
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim() ?? "";
  const baseURL =
    (process.env.DASHSCOPE_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(
      /\/+$/,
      ""
    );
  const model = process.env.DASHSCOPE_MODEL?.trim() || "qwen-plus-latest";
  /**
   * 单次 LLM 请求超时：正常调用 10-22s，25s 给充足缓冲；
   * 改为 25s 后，单段最坏耗时从 360s 降至 ~75s，配合 SEGMENT_TIMEOUT_MS=35s 整体封顶。
   */
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? "25000");

  if (!apiKey) {
    throw new Error(
      "Missing DASHSCOPE_API_KEY. Please set it in your environment (see .env.example)."
    );
  }

  return {
    apiKey,
    baseURL,
    model,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(5000, Math.floor(timeoutMs)) : 60000,
  };
}

/**
 * 创建阿里云 OpenAI 兼容客户端（DashScope）。
 *
 * 设计原因：
 * - 阿里云提供 OpenAI 兼容端点，可直接复用成熟的 OpenAI SDK；
 * - 我们通过 `baseURL/model` 可配置，方便你在不同地域/不同模型间切换（qwen-plus/flash/max 等）。
 */
export function createDashscopeClient(cfg: DashscopeConfig): OpenAI {
  return new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: cfg.timeoutMs });
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

export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
export async function chatJson<T>(
  opts: ChatJsonOptions
): Promise<{ rawText: string; json: T; usage?: LlmUsage }> {
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
    const usage = normalizeUsage(resp.usage);
    log.info("LLM chatJson ok", {
      purpose: opts.purpose,
      ms: Date.now() - t0,
      usage: resp.usage,
    });
    return { rawText, json, usage };
  } catch (err) {
    /**
     * 关键修复：仅对"格式不支持"类错误降级，超时/中止/限流直接重新抛出。
     *
     * 设计原因：
     * - 原逻辑对所有错误均降级，包括超时（AbortError）：第一次超时 60s + 降级再超时 60s = 120s/call；
     * - rewriteOneInternal 最多 3 次 chatJson → 最坏 360s；
     * - 配合 SEGMENT_TIMEOUT_MS=90s：实际每段等 90s，20 批 × 90s = 30 分钟（完全吻合生产卡住现象）；
     * - 修复后：超时直接失败，段落标为 failed 后跳过，不再浪费时间二次请求。
     */
    const isTimeout = (err instanceof Error) && (
      err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      err.message.includes("timed out") ||
      err.message.includes("timeout") ||
      err.message.includes("ECONNRESET") ||
      err.message.includes("ECONNABORTED")
    );
    const isRateLimit = (err as { status?: number })?.status === 429;

    if (isTimeout || isRateLimit) {
      // 超时或限流：直接上抛，避免再发一次等价的耗时请求
      log.warn("LLM chatJson timeout/ratelimit, skipping fallback", {
        purpose: opts.purpose,
        ms: Date.now() - t0,
        isTimeout,
        isRateLimit,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // 其他错误（如 response_format 不支持）：降级重试
    log.warn("LLM chatJson response_format failed; fallback", {
      purpose: opts.purpose,
      ms: Date.now() - t0,
      error: err instanceof Error ? { name: err.name, message: err.message } : { err },
    });
  }

  // 2) 降级：不带 response_format，但强制提示输出 JSON（仅当 response_format 不支持时走到这里）
  const resp2 = await opts.client.chat.completions.create(basePayload);
  const rawText2 = resp2.choices?.[0]?.message?.content ?? "";
  const json2 = safeParseJson<T>(rawText2);
  const usage2 = normalizeUsage(resp2.usage);
  log.info("LLM chatJson ok (fallback)", {
    purpose: opts.purpose,
    ms: Date.now() - t0,
    usage: resp2.usage,
  });
  return { rawText: rawText2, json: json2, usage: usage2 };
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

function normalizeUsage(
  usage:
    | {
        prompt_tokens?: number | null;
        completion_tokens?: number | null;
        total_tokens?: number | null;
      }
    | null
    | undefined
): LlmUsage | undefined {
  if (!usage) return undefined;
  const pt = Number(usage.prompt_tokens ?? 0);
  const ct = Number(usage.completion_tokens ?? 0);
  const tt = Number(usage.total_tokens ?? pt + ct);
  if (!Number.isFinite(pt) || !Number.isFinite(ct) || !Number.isFinite(tt)) return undefined;
  return {
    promptTokens: Math.max(0, Math.floor(pt)),
    completionTokens: Math.max(0, Math.floor(ct)),
    totalTokens: Math.max(0, Math.floor(tt)),
  };
}

