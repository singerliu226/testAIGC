import type { Router } from "express";
import type { AppLogger } from "../../../logger/index.js";
import type { SessionStore } from "../../sessionStore.js";
import type multer from "multer";
import { z } from "zod";
import { parseDocx } from "../../../docx/parser.js";
import { textToDocx } from "../../../docx/textToDocx.js";
import { detectAigcRisk } from "../../../analysis/detector.js";
import { judgeParagraphWithDashscope } from "../../../llm/judge.js";
import { asyncHandler } from "../asyncHandler.js";
import { uploadLimiter } from "../../rateLimit.js";
import { HttpError } from "../../errors.js";
import {
  getAccountIdFromRequestHeader,
  getDefaultFreePoints,
  ledger,
  consumeFreeTextChars,
  getFreeTextCharsRemaining,
  FREE_TEXT_CHARS_QUOTA,
} from "../../../billing/index.js";

export function registerUploadRoutes(params: {
  router: Router;
  logger: AppLogger;
  store: SessionStore;
  upload: multer.Multer;
}) {
  const router = params.router;

  router.post(
    "/upload",
    uploadLimiter,
    params.upload.single("file"),
    asyncHandler(async (req, res) => {
      const log = req.log ?? params.logger;
      const file = req.file;
      if (!file) throw new HttpError(400, "NO_FILE", "请上传 .docx 文件（字段名：file）");

      const decodedFilename = decodeMulterFilename(file.originalname);
      if (!decodedFilename.toLowerCase().endsWith(".docx")) {
        throw new HttpError(400, "INVALID_FILE", "目前仅支持 .docx");
      }

      // 读取并确保账号存在（创建会话时绑定 accountId，实现用户间数据隔离）
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());

      const session = params.store.create({
        filename: decodedFilename,
        originalDocx: file.buffer,
        accountId,
      });

      const t0 = Date.now();
      log.info("Uploaded docx", {
        sessionId: session.sessionId,
        filename: session.filename,
        size: file.size,
      });

      const parsed = await parseDocx(file.buffer);
      const t1 = Date.now();

      const paragraphs = parsed.paragraphs.map((p) => ({
        id: p.id,
        index: p.index,
        text: p.text,
        kind: p.kind,
      }));

      const reportBefore = detectAigcRisk(paragraphs);
      const t2 = Date.now();

      // 先保存规则检测结果并立即返回（避免 Zeabur 等平台的 HTTP 超时）
      const storedParas = parsed.paragraphs.map((p) => ({
        id: p.id,
        index: p.index,
        text: p.text,
        kind: p.kind,
      }));
      params.store.update(session.sessionId, {
        paragraphs: storedParas,
        reportBefore,
        reportAfter: undefined,
        revised: {},
        rewriteResults: {},
        revision: 0,
        revisedDocx: undefined,
        revisedDocxRevision: undefined,
      });
      const t3 = Date.now();

      // 分阶段计时日志：帮助定位大文件上传的性能瓶颈
      log.info("Docx upload pipeline timing", {
        sessionId: session.sessionId,
        fileSizeKB: Math.round(file.size / 1024),
        parseMs: t1 - t0,
        detectMs: t2 - t1,
        persistMs: t3 - t2,
        totalMs: t3 - t0,
        paragraphCount: parsed.paragraphs.length,
        imageParagraphs: paragraphs.filter((p) => p.kind === "imageParagraph").length,
        textParagraphs: paragraphs.filter((p) => p.kind === "paragraph").length,
      });

      res.json({
        ok: true,
        sessionId: session.sessionId,
        paragraphCount: parsed.paragraphs.length,
        report: reportBefore,
        judgeStatus: "pending",
        message: "规则检测完成，LLM 复核正在后台进行中…",
      });

      // ── LLM 复核在后台异步执行，不阻塞 HTTP 响应 ──
      const MAX_JUDGE = 30;
      const candidatesForJudge = reportBefore.paragraphReports
        .filter((r) => r.riskScore >= 50)
        .sort((a, b) => b.riskScore - a.riskScore)
        .slice(0, MAX_JUDGE);

      if (candidatesForJudge.length > 0 && process.env.DASHSCOPE_API_KEY) {
        (async () => {
          try {
            log.info("Starting background LLM judge review", {
              sessionId: session.sessionId,
              candidateCount: candidatesForJudge.length,
            });

            const judgeResults = await Promise.allSettled(
              candidatesForJudge.map((r) =>
                judgeParagraphWithDashscope({
                  logger: log,
                  paragraphText: r.text,
                  signals: r.signals,
                })
              )
            );

            for (let j = 0; j < candidatesForJudge.length; j++) {
              const result = judgeResults[j];
              if (result.status !== "fulfilled") continue;
              const judgeOutput = result.value;
              const paraReport = candidatesForJudge[j];

              const fused = Math.round(
                paraReport.riskScore * 0.4 + judgeOutput.riskScore0to100 * 0.6
              );
              paraReport.riskScore = Math.min(100, Math.max(0, fused));
              paraReport.riskLevel =
                paraReport.riskScore >= 70 ? "high" : paraReport.riskScore >= 35 ? "medium" : "low";

              if (judgeOutput.topReasons?.length) {
                paraReport.signals.push({
                  signalId: "llm_judge_review",
                  category: "aiPattern",
                  title: "AI 复核判断",
                  evidence: judgeOutput.topReasons.slice(0, 3),
                  suggestion: judgeOutput.shouldRewrite
                    ? "建议对此段落进行改写以降低 AI 痕迹。"
                    : "AI 复核认为此段落风险可控。",
                  score: 0,
                });
              }
            }

            // 重新计算文档整体分（对齐知网标准：AI字符数占比）
            let aiChars = 0,
              allChars = 0;
            for (const r of reportBefore.paragraphReports) {
              const len = r.text.length;
              allChars += len;
              if (r.riskScore >= 35) aiChars += len * (r.riskScore / 100);
            }
            reportBefore.overallRiskScore =
              allChars > 0 ? Math.min(100, Math.max(0, Math.round((aiChars / allChars) * 100))) : 0;
            reportBefore.overallRiskLevel =
              reportBefore.overallRiskScore >= 70
                ? "high"
                : reportBefore.overallRiskScore >= 35
                  ? "medium"
                  : "low";

            params.store.update(session.sessionId, { reportBefore });
            log.info("Background LLM judge completed", {
              sessionId: session.sessionId,
              overallScore: reportBefore.overallRiskScore,
            });
          } catch (err) {
            log.error("Background LLM judge failed", { error: String(err) });
          }
        })();
      }
    })
  );
}

/**
 * multer 在某些环境下将 UTF-8 文件名按 Latin-1 存入 originalname，
 * 导致中文显示为乱码。此函数尝试将 Latin-1 字节重新解码为 UTF-8。
 */
function decodeMulterFilename(raw: string): string {
  try {
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded;
  } catch {
    return raw;
  }
}

/**
 * 将粘贴文本按段落分割，返回非空段落数组。
 *
 * 设计原因：
 * - 用户从 Word/PDF 复制的文本通常用空行（\n\n）分隔段落；
 * - 若没有空行（例如纯换行），退化为按单换行切分，保证至少能产出多个段落；
 * - 单段字符数上限 3000，超出时在标点处截断以保持语义完整性。
 */
function splitTextToParagraphs(text: string): string[] {
  const MAX_PARA_CHARS = 3000;
  const MAX_TOTAL_PARAS = 300;

  // 优先按空行分段
  let rawParas = text.split(/\n{2,}/);
  // 若空行分段结果 < 2，退化为单换行分段
  if (rawParas.length < 2) {
    rawParas = text.split(/\n/);
  }

  const result: string[] = [];
  for (const raw of rawParas) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (trimmed.length <= MAX_PARA_CHARS) {
      result.push(trimmed);
    } else {
      // 超长段落在标点处截断，产出多个子段
      const subParas = splitLongParagraph(trimmed, MAX_PARA_CHARS);
      result.push(...subParas);
    }

    if (result.length >= MAX_TOTAL_PARAS) break;
  }

  return result;
}

/**
 * 将超长段落在句号/问号/感叹号处截断，使每段不超过 maxLen 字符。
 * 若找不到合适的断点，则硬截。
 */
function splitLongParagraph(text: string, maxLen: number): string[] {
  const result: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // 在 maxLen 范围内从后往前找标点断点
    const slice = remaining.slice(0, maxLen);
    const breakIdx = Math.max(
      slice.lastIndexOf("。"),
      slice.lastIndexOf("？"),
      slice.lastIndexOf("！"),
      slice.lastIndexOf("."),
      slice.lastIndexOf("?"),
      slice.lastIndexOf("!")
    );

    const cut = breakIdx > maxLen * 0.5 ? breakIdx + 1 : maxLen;
    result.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) result.push(remaining);
  return result;
}

/**
 * 纯文字粘贴上传：将粘贴文本转为最小 docx，走与文件上传相同的检测流程。
 *
 * 设计原因：
 * - 部分用户无法上传 .docx 文件（格式不兼容、系统限制等）；
 * - 纯文字入口让他们可以直接粘贴论文内容完成检测与改写，体验与文件上传等价。
 * - isTextInput=true 标记告知前端用"复制结果面板"而非"下载 docx"作为输出方式。
 */
export function registerUploadTextRoute(params: {
  router: Router;
  logger: AppLogger;
  store: SessionStore;
}) {
  const router = params.router;

  router.post(
    "/upload-text",
    uploadLimiter,
    asyncHandler(async (req, res) => {
      const log = req.log ?? params.logger;

      const body = z
        .object({ text: z.string().min(10).max(150000) })
        .parse(req.body);

      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());

      const paragraphTexts = splitTextToParagraphs(body.text);
      if (paragraphTexts.length < 1) {
        throw new HttpError(400, "EMPTY_TEXT", "未能从粘贴内容中识别有效段落，请检查文字格式");
      }

      // ── 免费额度检查 ──
      // 文字粘贴检测不消耗积分，但每账号终身只有 FREE_TEXT_CHARS_QUOTA（10,000 字）的免费额度。
      // 额度用尽后返回 402，引导用户改用文件上传（永久免费）。
      const charLen = body.text.length;
      try {
        consumeFreeTextChars(accountId, charLen);
      } catch (quotaErr: unknown) {
        if ((quotaErr as { code?: string }).code === "FREE_TEXT_QUOTA_EXCEEDED") {
          const freeRemaining = getFreeTextCharsRemaining(accountId);
          res.status(402).json({
            ok: false,
            error: "FREE_TEXT_QUOTA_EXCEEDED",
            message: `文字检测免费额度（${FREE_TEXT_CHARS_QUOTA.toLocaleString()} 字）已用完。直接上传 .docx 文件可永久免费检测。`,
            freeRemaining,
          });
          return;
        }
        throw quotaErr;
      }

      log.info("Text upload: split paragraphs", {
        accountId,
        paragraphCount: paragraphTexts.length,
        totalChars: body.text.length,
        freeRemaining: getFreeTextCharsRemaining(accountId),
      });

      // 生成最小合法 docx，保证后续 parseDocx / patchDocxParagraphs 可正常工作
      const docxBuffer = await textToDocx(paragraphTexts);
      const parsed = await parseDocx(docxBuffer);
      const paragraphs = parsed.paragraphs.map((p) => ({
        id: p.id,
        index: p.index,
        text: p.text,
        kind: p.kind,
      }));

      const reportBefore = detectAigcRisk(paragraphs);

      const filename = `粘贴文字-${new Date().toISOString().slice(0, 10)}.txt`;
      const session = params.store.create({
        filename,
        originalDocx: docxBuffer,
        accountId,
      });

      params.store.update(session.sessionId, {
        isTextInput: true,
        paragraphs,
        reportBefore,
        reportAfter: undefined,
        revised: {},
        rewriteResults: {},
        revision: 0,
        revisedDocx: undefined,
        revisedDocxRevision: undefined,
      });

      log.info("Text upload: session created", {
        sessionId: session.sessionId,
        paragraphCount: paragraphs.length,
        overallRiskScore: reportBefore.overallRiskScore,
      });

      res.json({
        ok: true,
        sessionId: session.sessionId,
        paragraphCount: paragraphs.length,
        report: reportBefore,
        judgeStatus: "pending",
        message: "规则检测完成，LLM 复核正在后台进行中…",
        // 额度消耗后剩余量，供前端实时更新配额显示
        freeRemaining: getFreeTextCharsRemaining(accountId),
      });

      // ── LLM 复核在后台异步执行（与 /upload 逻辑完全相同） ──
      const MAX_JUDGE = 30;
      const candidatesForJudge = reportBefore.paragraphReports
        .filter((r) => r.riskScore >= 50)
        .sort((a, b) => b.riskScore - a.riskScore)
        .slice(0, MAX_JUDGE);

      if (candidatesForJudge.length > 0 && process.env.DASHSCOPE_API_KEY) {
        (async () => {
          try {
            log.info("Text upload: starting background LLM judge", {
              sessionId: session.sessionId,
              candidateCount: candidatesForJudge.length,
            });

            const judgeResults = await Promise.allSettled(
              candidatesForJudge.map((r) =>
                judgeParagraphWithDashscope({
                  logger: log,
                  paragraphText: r.text,
                  signals: r.signals,
                })
              )
            );

            for (let j = 0; j < candidatesForJudge.length; j++) {
              const result = judgeResults[j];
              if (result.status !== "fulfilled") continue;
              const judgeOutput = result.value;
              const paraReport = candidatesForJudge[j];

              const fused = Math.round(
                paraReport.riskScore * 0.4 + judgeOutput.riskScore0to100 * 0.6
              );
              paraReport.riskScore = Math.min(100, Math.max(0, fused));
              paraReport.riskLevel =
                paraReport.riskScore >= 70 ? "high" : paraReport.riskScore >= 35 ? "medium" : "low";

              if (judgeOutput.topReasons?.length) {
                paraReport.signals.push({
                  signalId: "llm_judge_review",
                  category: "aiPattern",
                  title: "AI 复核判断",
                  evidence: judgeOutput.topReasons.slice(0, 3),
                  suggestion: judgeOutput.shouldRewrite
                    ? "建议对此段落进行改写以降低 AI 痕迹。"
                    : "AI 复核认为此段落风险可控。",
                  score: 0,
                });
              }
            }

            // 重新计算文档整体分
            let aiChars = 0, allChars = 0;
            for (const r of reportBefore.paragraphReports) {
              const len = r.text.length;
              allChars += len;
              if (r.riskScore >= 35) aiChars += len * (r.riskScore / 100);
            }
            reportBefore.overallRiskScore =
              allChars > 0 ? Math.min(100, Math.max(0, Math.round((aiChars / allChars) * 100))) : 0;
            reportBefore.overallRiskLevel =
              reportBefore.overallRiskScore >= 70 ? "high" : reportBefore.overallRiskScore >= 35 ? "medium" : "low";

            params.store.update(session.sessionId, { reportBefore });
            log.info("Text upload: background LLM judge completed", {
              sessionId: session.sessionId,
              overallScore: reportBefore.overallRiskScore,
            });
          } catch (err) {
            log.error("Text upload: background LLM judge failed", { error: String(err) });
          }
        })();
      }
    })
  );
}

