import type { AppLogger } from "../logger/index.js";
import type { FindingSignal } from "../report/schema.js";
import {
  chatJson,
  createDashscopeClient,
  loadDashscopeConfigFromEnv,
} from "./client.js";
import { buildRewriteMessages, type RewriteOutput } from "./prompts.js";

export type RewriteParams = {
  logger: AppLogger;
  paragraphText: string;
  contextBefore?: string;
  contextAfter?: string;
  signals: FindingSignal[];
};

/**
 * 调用大模型对段落进行“可控改写”，输出结构化结果。
 *
 * 设计原因：
 * - 改写是可选步骤，但一旦启用就必须“可回写”：因此我们强制 JSON 输出并解析校验；
 * - 通过传入上下文与信号，让模型知道“为什么改、要解决什么”，避免泛化润色。
 */
export async function rewriteParagraphWithDashscope(
  params: RewriteParams
): Promise<RewriteOutput> {
  const cfg = loadDashscopeConfigFromEnv();
  const client = createDashscopeClient(cfg);

  const { json } = await chatJson<RewriteOutput>({
    logger: params.logger,
    client,
    model: cfg.model,
    purpose: "rewrite.paragraph",
    temperature: 0.2,
    messages: buildRewriteMessages({
      paragraphText: params.paragraphText,
      contextBefore: params.contextBefore,
      contextAfter: params.contextAfter,
      signals: params.signals,
    }),
  });

  if (!json?.revisedText || typeof json.revisedText !== "string") {
    throw new Error("LLM rewrite output missing revisedText");
  }

  return {
    revisedText: json.revisedText,
    changeRationale: Array.isArray(json.changeRationale) ? json.changeRationale : [],
    riskSignalsResolved: Array.isArray(json.riskSignalsResolved) ? json.riskSignalsResolved : [],
    needHumanCheck: Array.isArray(json.needHumanCheck) ? json.needHumanCheck : [],
    humanFeatures: Array.isArray(json.humanFeatures) ? json.humanFeatures : [],
  };
}

