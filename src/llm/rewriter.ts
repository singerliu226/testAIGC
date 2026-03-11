import type { AppLogger } from "../logger/index.js";
import type { FindingSignal } from "../report/schema.js";
import {
  chatJson,
  createDashscopeClient,
  loadDashscopeConfigFromEnv,
} from "./client.js";
import { buildRewriteMessages, type RewriteMessageOptions, type RewriteOutput } from "./prompts.js";
import type { LlmUsage } from "./client.js";
import { lockFacts, restoreFacts, validatePlaceholders } from "./factLocker.js";

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
  /** 护栏拦截原因提示（用于 repair 模式） */
  guardViolationsHint?: string;
  /**
   * 是否启用事实锚点锁定（可选）。
   * 默认建议：自动降分的强力改写阶段启用，以提升降幅并减少护栏拦截。
   */
  factLock?: boolean;
};

export type RewriteOutputWithUsage = RewriteOutput & { usage?: LlmUsage };

/**
 * 调用大模型对段落进行“可控改写”，输出结构化结果。
 *
 * 设计原因：
 * - 改写是可选步骤，但一旦启用就必须“可回写”：因此我们强制 JSON 输出并解析校验；
 * - 通过传入上下文与信号，让模型知道“为什么改、要解决什么”，避免泛化润色。
 */
export async function rewriteParagraphWithDashscope(
  params: RewriteParams
): Promise<RewriteOutputWithUsage> {
  const cfg = loadDashscopeConfigFromEnv();
  const client = createDashscopeClient(cfg);

  const mode: NonNullable<RewriteMessageOptions["mode"]> = params.rewriteMode ?? "normal";
  const factLockEnabled = Boolean(params.factLock);
  const temperature = mode === "aggressive" ? 0.6 : mode === "repair" ? 0.1 : 0.2;
  const purpose =
    mode === "aggressive"
      ? "rewrite.paragraph.aggressive"
      : mode === "repair"
        ? "rewrite.paragraph.repair"
        : "rewrite.paragraph";

  const factLocked = factLockEnabled ? lockFacts(params.paragraphText) : null;
  const paragraphText = factLocked ? factLocked.maskedText : params.paragraphText;

  const { json, usage } = await chatJson<RewriteOutput>({
    logger: params.logger,
    client,
    model: cfg.model,
    purpose,
    temperature,
    messages: buildRewriteMessages({
      paragraphText,
      contextBefore: params.contextBefore,
      contextAfter: params.contextAfter,
      signals: params.signals,
      guardViolationsHint: params.guardViolationsHint,
    }, { mode, minChangeRatio: params.minChangeRatio, factLock: factLockEnabled }),
  });

  if (!json?.revisedText || typeof json.revisedText !== "string") {
    throw new Error("LLM rewrite output missing revisedText");
  }

  const revisedMasked = json.revisedText;
  if (factLocked) {
    const ph = validatePlaceholders({ text: revisedMasked, items: factLocked.items });
    if (!ph.ok) {
      params.logger.warn("Fact lock placeholders missing, falling back to no-factLock rewrite", {
        purpose,
        missing: ph.missing.slice(0, 6),
      });
      // 占位符丢失时，降级为不带 factLock 的重写，避免整段失败浪费用户时间
      const { json: json2, usage: usage2 } = await chatJson<RewriteOutput>({
        logger: params.logger,
        client,
        model: cfg.model,
        purpose: purpose + ".fallback",
        temperature,
        messages: buildRewriteMessages({
          paragraphText: params.paragraphText,
          contextBefore: params.contextBefore,
          contextAfter: params.contextAfter,
          signals: params.signals,
          guardViolationsHint: params.guardViolationsHint,
        }, { mode, minChangeRatio: params.minChangeRatio, factLock: false }),
      });
      if (!json2?.revisedText || typeof json2.revisedText !== "string") {
        throw new Error("LLM fallback rewrite output missing revisedText");
      }
      return {
        revisedText: json2.revisedText,
        changeRationale: Array.isArray(json2.changeRationale) ? json2.changeRationale : [],
        riskSignalsResolved: Array.isArray(json2.riskSignalsResolved) ? json2.riskSignalsResolved : [],
        needHumanCheck: Array.isArray(json2.needHumanCheck) ? json2.needHumanCheck : [],
        humanFeatures: Array.isArray(json2.humanFeatures) ? json2.humanFeatures : [],
        usage: usage2,
      };
    }
  }

  const revisedText = factLocked ? restoreFacts({ text: revisedMasked, items: factLocked.items }) : revisedMasked;

  return {
    revisedText,
    changeRationale: Array.isArray(json.changeRationale) ? json.changeRationale : [],
    riskSignalsResolved: Array.isArray(json.riskSignalsResolved) ? json.riskSignalsResolved : [],
    needHumanCheck: Array.isArray(json.needHumanCheck) ? json.needHumanCheck : [],
    humanFeatures: Array.isArray(json.humanFeatures) ? json.humanFeatures : [],
    usage,
  };
}

