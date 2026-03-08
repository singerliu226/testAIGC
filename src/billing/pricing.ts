import type { LlmUsage } from "../llm/client.js";

export type BillingMode = "chars" | "tokens";

export type BillingConfig = {
  mode: BillingMode;
  /**
   * 每 1000 tokens 对应的积分数。
   *
   * 设计原因：
   * - LLM 成本与 token 线性相关，用 tokens 计费更贴近真实成本；
   * - 通过该参数可在不改代码的情况下调价。
   */
  pointsPer1kTokens: number;
  /** 单次调用最小扣费积分（防止 0 或极低成本被滥用） */
  minPointsPerCall: number;
  /**
   * 预扣费倍率（用于 tokens 计费模式下的“先预扣、后结算”）。
   *
   * 设计原因：
   * - tokens 使用量必须等模型返回才知道，但我们需要先做余额校验；
   * - 预扣倍率偏保守，可降低“需要补扣但余额不足”的概率。
   */
  prechargeMultiplier: number;
};

export function loadBillingConfigFromEnv(): BillingConfig {
  const mode = String(process.env.BILLING_MODE ?? "tokens").toLowerCase() as BillingMode;
  const pointsPer1kTokens = numEnv("POINTS_PER_1K_TOKENS", 1);
  const minPointsPerCall = Math.max(1, Math.floor(numEnv("MIN_POINTS_PER_CALL", 1)));
  const prechargeMultiplier = clamp(numEnv("PRECHARGE_MULTIPLIER", 1.4), 1, 5);

  return {
    mode: mode === "chars" ? "chars" : "tokens",
    pointsPer1kTokens: Math.max(0.1, pointsPer1kTokens),
    minPointsPerCall,
    prechargeMultiplier,
  };
}

/**
 * 计算“预扣积分”。
 *
 * 实现方式：
 * - chars 模式：沿用原逻辑（约每 200 字 1 积分）
 * - tokens 模式：仍用字数做保守估算，再乘预扣倍率
 */
export function estimatePrechargePoints(params: { text: string; cfg: BillingConfig }): number {
  const base = estimatePointsByChars(params.text);
  if (params.cfg.mode === "chars") return Math.max(params.cfg.minPointsPerCall, base);
  return Math.max(params.cfg.minPointsPerCall, Math.ceil(base * params.cfg.prechargeMultiplier));
}

/**
 * 计算“最终应扣积分”。
 *
 * 实现方式：
 * - tokens 模式：优先用 usage.totalTokens
 * - 缺失 usage 时降级为 chars 估算（保证可运行）
 */
export function calcFinalChargePoints(params: { text: string; usage?: LlmUsage; cfg: BillingConfig }): number {
  if (params.cfg.mode === "chars") return Math.max(params.cfg.minPointsPerCall, estimatePointsByChars(params.text));
  const usage = params.usage;
  if (!usage?.totalTokens) return Math.max(params.cfg.minPointsPerCall, estimatePointsByChars(params.text));
  const pts = Math.ceil((usage.totalTokens / 1000) * params.cfg.pointsPer1kTokens);
  return Math.max(params.cfg.minPointsPerCall, pts);
}

export function estimatePointsByChars(text: string): number {
  const len = (text ?? "").trim().length;
  if (!len) return 1;
  return Math.max(1, Math.ceil(len / 200));
}

function numEnv(key: string, fallback: number): number {
  const v = Number(process.env[key] ?? "");
  return Number.isFinite(v) ? v : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

