import type { AppLogger } from "../logger/index.js";
import type { FindingSignal } from "../report/schema.js";
import {
  chatJson,
  createDashscopeClient,
  loadDashscopeConfigFromEnv,
} from "./client.js";
import { buildJudgeMessages, type JudgeOutput } from "./prompts.js";

export type JudgeParams = {
  logger: AppLogger;
  paragraphText: string;
  signals: FindingSignal[];
};

/**
 * 使用大模型对规则检测结果做二次复核（可选）。
 *
 * 设计原因：
 * - 规则检测“稳定可复现”，但对边界样例可能偏保守；
 * - LLM 复核可以在不泄露整篇文档结构的前提下，给出更接近人类审阅的判断与理由。
 *
 * 注意：
 * - 复核不应取代规则信号，而应作为“加权/解释”的补充。
 */
export async function judgeParagraphWithDashscope(params: JudgeParams): Promise<JudgeOutput> {
  const cfg = loadDashscopeConfigFromEnv();
  const client = createDashscopeClient(cfg);

  const { json } = await chatJson<JudgeOutput>({
    logger: params.logger,
    client,
    model: cfg.model,
    purpose: "judge.paragraph",
    temperature: 0.1,
    messages: buildJudgeMessages({
      paragraphText: params.paragraphText,
      signals: params.signals,
    }),
  });

  const riskScore0to100 = Number(json?.riskScore0to100);
  const normalized = Number.isFinite(riskScore0to100)
    ? Math.min(100, Math.max(0, riskScore0to100))
    : 0;

  const lvl =
    json?.riskLevel === "high" || json?.riskLevel === "medium" || json?.riskLevel === "low"
      ? json.riskLevel
      : normalized >= 70
        ? "high"
        : normalized >= 35
          ? "medium"
          : "low";

  return {
    riskScore0to100: normalized,
    riskLevel: lvl,
    topReasons: Array.isArray(json?.topReasons) ? json.topReasons : [],
    shouldRewrite: Boolean(json?.shouldRewrite),
  };
}

