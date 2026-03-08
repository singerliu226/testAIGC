import type { AppLogger } from "../logger/index.js";
import type { FindingSignal } from "../report/schema.js";
import {
  chatJson,
  createDashscopeClient,
  loadDashscopeConfigFromEnv,
} from "./client.js";
import { buildRewriteMessages, type RewriteMessageOptions, type RewriteOutput } from "./prompts.js";

export type RewriteParams = {
  logger: AppLogger;
  paragraphText: string;
  contextBefore?: string;
  contextAfter?: string;
  signals: FindingSignal[];
  /**
   * 改写强度（可选）。
   *
   * 设计原因：
   * - 部分用户反馈“点了一键改写但 AI 率不变”，常见原因是模型输出与原文过于相似；
   * - 允许在服务端做一次“强力改写重试”，以提升总体有效性。
   */
  rewriteMode?: RewriteMessageOptions["mode"];
  /** 最小表层改动比例（仅在强力改写时用于约束） */
  minChangeRatio?: RewriteMessageOptions["minChangeRatio"];
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

  const mode: NonNullable<RewriteMessageOptions["mode"]> = params.rewriteMode ?? "normal";
  const temperature = mode === "aggressive" ? 0.6 : 0.2;
  const purpose = mode === "aggressive" ? "rewrite.paragraph.aggressive" : "rewrite.paragraph";

  const { json } = await chatJson<RewriteOutput>({
    logger: params.logger,
    client,
    model: cfg.model,
    purpose,
    temperature,
    messages: buildRewriteMessages({
      paragraphText: params.paragraphText,
      contextBefore: params.contextBefore,
      contextAfter: params.contextAfter,
      signals: params.signals,
    }, { mode, minChangeRatio: params.minChangeRatio }),
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

