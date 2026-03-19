import type { AppLogger } from "../logger/index.js";
import type { FindingSignal } from "../report/schema.js";
import {
  chatJson,
  createDashscopeClient,
  loadDashscopeConfigFromEnv,
} from "./client.js";
import { buildJudgeMessages, buildCnkiJudgeMessages, type JudgeOutput } from "./prompts.js";

export type JudgeParams = {
  logger: AppLogger;
  paragraphText: string;
  signals: FindingSignal[];
  roleTags?: string[];
  cnkiReasons?: string[];
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
      roleTags: params.roleTags,
      cnkiReasons: params.cnkiReasons,
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

/**
 * 使用知网口径专项 prompt 对段落进行评分。
 *
 * 设计原因：
 * - 通用 judge 的 prompt 侧重"AI 生成痕迹"，知网侧重"学术模板感"；
 * - 单独抽出知网口径 judge，使 uploadRoutes 可在中文复核流程中替换调用，
 *   从而让 cnkiRiskScore 更贴近知网实测值，收窄系统与知网的评分差距。
 * - temperature 保持 0.1（低温保证稳定性），与通用 judge 一致。
 */
export async function judgeParagraphCnkiStyle(params: JudgeParams): Promise<JudgeOutput> {
  const cfg = loadDashscopeConfigFromEnv();
  const client = createDashscopeClient(cfg);

  const { json } = await chatJson<JudgeOutput>({
    logger: params.logger,
    client,
    model: cfg.model,
    purpose: "judge.paragraph.cnki",
    temperature: 0.1,
    messages: buildCnkiJudgeMessages({
      paragraphText: params.paragraphText,
      signals: params.signals,
      roleTags: params.roleTags,
      cnkiReasons: params.cnkiReasons,
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

