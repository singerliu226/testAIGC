import type { Router } from "express";
import type { AppLogger } from "../../../logger/index.js";
import type { CnkiRoleTag } from "../../../analysis/cnkiRoleFeatures.js";
import type { DocumentReport } from "../../../report/schema.js";
import type { SessionStore } from "../../sessionStore.js";
import type multer from "multer";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocx } from "../../../docx/parser.js";
import {
  computeCnkiOverallScore,
  computeCnkiParagraphScore,
  computeRawOverallScore,
} from "../../../analysis/cnkiCalibrator.js";
import {
  fuseCnkiJudgeScore,
  shouldReviewWithCnkiJudge,
  sortCnkiJudgeCandidates,
} from "../../../analysis/cnkiLlmFusion.js";
import { textToDocx } from "../../../docx/textToDocx.js";
import { detectAigcRisk, detectAigcRiskAsync } from "../../../analysis/detector.js";
import { createDashscopeClient, loadDashscopeConfigFromEnv } from "../../../llm/client.js";
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
import { estimatePointsByChars } from "../../../billing/pricing.js";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

function riskLevel(score: number): "low" | "medium" | "high" {
  if (score >= 70) return "high";
  if (score >= 35) return "medium";
  return "low";
}

const VALID_CNKI_ROLE_TAGS = new Set<CnkiRoleTag>([
  "chapterRoadmap",
  "researchBackground",
  "literatureReview",
  "researchPurpose",
  "researchSignificance",
  "researchMethod",
  "theoreticalFramework",
  "limitations",
  "futureWork",
  "conclusionSummary",
]);

function normalizeCnkiRoleTags(roleTags: string[]): CnkiRoleTag[] {
  return roleTags.filter((tag): tag is CnkiRoleTag => VALID_CNKI_ROLE_TAGS.has(tag as CnkiRoleTag));
}

/**
 * 统一执行中文报告的后台 LLM 复核。
 *
 * 设计原因：
 * - 文件上传与纯文字上传必须走同一条知网对齐链路，否则会出现同文不同分；
 * - 将候选选择、动态融合、双总分回算收口到一个函数里，避免后续再次分叉。
 */
function startBackgroundCnkiJudgeReview(params: {
  logger: AppLogger;
  store: SessionStore;
  sessionId: string;
  reportBefore: DocumentReport;
  label: string;
}) {
  const MAX_JUDGE = 40;
  const candidatesForJudge = sortCnkiJudgeCandidates(
    params.reportBefore.paragraphReports.filter((report) =>
      shouldReviewWithCnkiJudge({
        riskScore: report.riskScore,
        cnkiRiskScore: report.cnkiRiskScore,
        roleTags: report.roleTags,
      })
    )
  ).slice(0, MAX_JUDGE);

  if (candidatesForJudge.length === 0 || !process.env.DASHSCOPE_API_KEY) return;

  void (async () => {
    try {
      params.logger.info(`${params.label}: starting background LLM judge`, {
        sessionId: params.sessionId,
        candidateCount: candidatesForJudge.length,
      });

      const judgeResults = await Promise.allSettled(
        candidatesForJudge.map((report) =>
          judgeParagraphWithDashscope({
            logger: params.logger,
            paragraphText: report.text,
            signals: report.signals,
            roleTags: report.roleTags,
            cnkiReasons: report.cnkiReasons,
          })
        )
      );

      for (let index = 0; index < candidatesForJudge.length; index += 1) {
        const result = judgeResults[index];
        if (result.status !== "fulfilled") continue;

        const paraReport = candidatesForJudge[index];
        paraReport.riskScore = fuseCnkiJudgeScore({
          rawRiskScore: paraReport.riskScore,
          judgeRiskScore: result.value.riskScore0to100,
          roleTags: paraReport.roleTags,
        });
        paraReport.rawRiskScore = paraReport.riskScore;
        paraReport.cnkiRiskScore = computeCnkiParagraphScore({
          rawRiskScore: paraReport.riskScore,
          roleTags: normalizeCnkiRoleTags(paraReport.roleTags ?? []),
          signals: paraReport.signals,
          text: paraReport.text,
        });
        paraReport.riskLevel = riskLevel(paraReport.riskScore);

        if (result.value.topReasons?.length) {
          paraReport.signals.push({
            signalId: "llm_judge_review",
            category: "aiPattern",
            title: "AI 复核判断",
            evidence: result.value.topReasons.slice(0, 3),
            suggestion: result.value.shouldRewrite
              ? "建议对此段落进行改写以降低 AI 痕迹。"
              : "AI 复核认为此段落风险可控。",
            score: 0,
          });
        }
      }

      params.reportBefore.overallRiskScore = computeRawOverallScore(params.reportBefore.paragraphReports);
      params.reportBefore.overallRiskLevel = riskLevel(params.reportBefore.overallRiskScore);
      params.reportBefore.overallCnkiPredictedScore =
        computeCnkiOverallScore(params.reportBefore.paragraphReports);
      params.reportBefore.overallCnkiPredictedLevel = riskLevel(
        params.reportBefore.overallCnkiPredictedScore
      );

      params.store.update(params.sessionId, { reportBefore: params.reportBefore });
      params.logger.info(`${params.label}: background LLM judge completed`, {
        sessionId: params.sessionId,
        overallScore: params.reportBefore.overallRiskScore,
        overallCnkiPredictedScore: params.reportBefore.overallCnkiPredictedScore,
      });
    } catch (err) {
      params.logger.error(`${params.label}: background LLM judge failed`, {
        error: String(err),
      });
    }
  })();
}

/**
 * 将 .doc（旧版 OLE2 二进制格式）转换为 .docx buffer。
 *
 * 设计原因：
 * - 系统核心依赖 jszip 解析 .docx（zip-based XML），无法直接解析 .doc 二进制格式；
 * - macOS 内置 textutil 可以无损转换 .doc → .docx，无需额外安装依赖；
 * - 转换使用临时文件，转换完成后立即清理，不落盘持久化。
 */
async function convertDocToDocx(buffer: Buffer, logger: AppLogger): Promise<Buffer> {
  const tmpId = randomUUID();
  const inPath = join(tmpdir(), `${tmpId}.doc`);
  const outPath = join(tmpdir(), `${tmpId}.docx`);

  try {
    await writeFile(inPath, buffer);
    await execFileAsync("textutil", ["-convert", "docx", inPath, "-output", outPath]);
    const docxBuffer = await readFile(outPath);
    logger.info("Converted .doc to .docx via textutil", {
      inputSizeKB: Math.round(buffer.length / 1024),
      outputSizeKB: Math.round(docxBuffer.length / 1024),
    });
    return docxBuffer;
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

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
      const lowerFilename = decodedFilename.toLowerCase();
      if (!lowerFilename.endsWith(".docx") && !lowerFilename.endsWith(".doc")) {
        throw new HttpError(400, "INVALID_FILE", "目前支持 .docx 和 .doc 格式");
      }

      // 读取并确保账号存在（创建会话时绑定 accountId，实现用户间数据隔离）
      const accountId = getAccountIdFromRequestHeader(req.header("x-account-id"));
      ledger.ensureAccount(accountId, getDefaultFreePoints());

      // .doc 文件自动转换为 .docx（仅 macOS 支持，依赖系统自带 textutil）
      let docxBuffer = file.buffer;
      if (lowerFilename.endsWith(".doc")) {
        try {
          docxBuffer = await convertDocToDocx(file.buffer, log);
        } catch (convErr) {
          log.error(".doc conversion failed", {
            filename: decodedFilename,
            error: convErr instanceof Error ? convErr.message : String(convErr),
          });
          throw new HttpError(422, "DOC_CONVERT_FAILED", ".doc 文件转换失败，请另存为 .docx 后重新上传");
        }
      }

      const session = params.store.create({
        filename: decodedFilename,
        originalDocx: docxBuffer,
        accountId,
      });

      log.info("Uploaded file, starting background parse", {
        sessionId: session.sessionId,
        filename: session.filename,
        originalSize: file.size,
        docxSize: docxBuffer.length,
      });

      /**
       * 立即响应：上传接收成功后马上返回 sessionId + status:"parsing"。
       *
       * 设计原因：
       * - parseDocx + detectAigcRisk + 磁盘持久化在大文件（300+段落、含图片）时
       *   可能超过 Zeabur 反向代理的读超时（约 60s），导致 502 Bad Gateway；
       * - 改为后台异步处理：前端收到 sessionId 后开始轮询 /api/session/:sessionId，
       *   直到 reportBefore 出现，与现有 judgeStatus 轮询机制完全一致。
       */
      res.json({
        ok: true,
        sessionId: session.sessionId,
        status: "parsing",
        message: "文件已接收，正在解析中，请稍候…",
      });

      // ── 后台异步解析 + 检测 ──
      (async () => {
        const t0 = Date.now();
        let parsed: Awaited<ReturnType<typeof parseDocx>>;
        try {
          parsed = await parseDocx(docxBuffer);
        } catch (parseErr) {
          log.error("Docx parse failed (background)", {
            sessionId: session.sessionId,
            filename: session.filename,
            fileSizeKB: Math.round(docxBuffer.length / 1024),
            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            stack: parseErr instanceof Error ? parseErr.stack?.slice(0, 500) : undefined,
          });
          // 将解析错误写入 session，前端轮询时读取并展示
          params.store.update(session.sessionId, {
            parseError: `文件解析失败：${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          });
          return;
        }
        const t1 = Date.now();

        const paragraphs = parsed.paragraphs.map((p) => ({
          id: p.id,
          index: p.index,
          text: p.text,
          kind: p.kind,
        }));

        // 检测文档语言：英文走 LLM 主判断路径（后台异步），中文走规则引擎（同步快速返回）
        const { detectDocumentLanguage: detectLang } = await import(
          "../../../analysis/textUtils.js"
        );
        const docLang = detectLang(paragraphs);
        const isEnglish = docLang === "en";

        // 准备 LLM 依赖（英文 LLM 检测 + 中文 LLM 复核均需要）
        let llmDeps: Parameters<typeof detectAigcRiskAsync>[1] | undefined;
        try {
          const llmCfg = loadDashscopeConfigFromEnv();
          llmDeps = {
            llmClient: createDashscopeClient(llmCfg),
            model: llmCfg.model,
            logger: log,
          };
        } catch {
          log.warn("LLM config unavailable, falling back to rule-based detection");
        }

        const reportBefore = detectAigcRisk(paragraphs);
        const t2 = Date.now();

        params.store.update(session.sessionId, {
          paragraphs,
          reportBefore,
          reportAfter: undefined,
          revised: {},
          rewriteResults: {},
          revision: 0,
          revisedDocx: undefined,
          revisedDocxRevision: undefined,
          isEnglish,
        });
        const t3 = Date.now();

        const emptyTextParas = paragraphs.filter((p) => p.kind === "paragraph" && !p.text.trim()).length;
        log.info("Docx upload pipeline timing (background)", {
          sessionId: session.sessionId,
          fileSizeKB: Math.round(file.size / 1024),
          parseMs: t1 - t0,
          detectMs: t2 - t1,
          persistMs: t3 - t2,
          totalMs: t3 - t0,
          paragraphCount: parsed.paragraphs.length,
          imageParagraphs: paragraphs.filter((p) => p.kind === "imageParagraph").length,
          textParagraphs: paragraphs.filter((p) => p.kind === "paragraph").length,
          emptyTextParas,
          overallRiskScore: reportBefore.overallRiskScore,
          docLang,
        });

        // ── 后台异步 LLM 处理 ──
        if (process.env.DASHSCOPE_API_KEY && llmDeps) {
          if (isEnglish) {
            const enLlmDeps = llmDeps;
            (async () => {
              try {
                log.info("Starting background English LLM detection", {
                  sessionId: session.sessionId,
                  paragraphCount: paragraphs.length,
                });
                const enReport = await detectAigcRiskAsync(paragraphs, enLlmDeps);
                params.store.update(session.sessionId, { reportBefore: enReport });
                log.info("Background English LLM detection completed", {
                  sessionId: session.sessionId,
                  overallScore: enReport.overallRiskScore,
                });
              } catch (err) {
                log.error("Background English LLM detection failed", { error: String(err) });
              }
            })();
          } else {
            startBackgroundCnkiJudgeReview({
              logger: log,
              store: params.store,
              sessionId: session.sessionId,
              reportBefore,
              label: "File upload",
            });
          }
        }
      })();
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

      // ── 免费额度检查 + 积分降级扣费 ──
      // 文字粘贴检测每账号终身有 FREE_TEXT_CHARS_QUOTA（10,000 字）的免费额度。
      // 免费额度耗尽后，改为按字符数扣积分（约每 200 字 1 积分），确保用户仍可正常使用。
      // 若积分也不足，则返回 402 提示充值。
      const charLen = body.text.length;
      let detectionChargedPoints = 0;
      try {
        consumeFreeTextChars(accountId, charLen);
      } catch (quotaErr: unknown) {
        if ((quotaErr as { code?: string }).code === "FREE_TEXT_QUOTA_EXCEEDED") {
          // 免费额度不足，尝试用积分支付本次检测
          const pointsNeeded = Math.max(1, estimatePointsByChars(body.text));
          const balance = ledger.getBalance(accountId);
          if (balance < pointsNeeded) {
            res.status(402).json({
              ok: false,
              error: "INSUFFICIENT_POINTS",
              message: `文字检测免费额度（${FREE_TEXT_CHARS_QUOTA.toLocaleString()} 字）已用完，本次检测需 ${pointsNeeded} 积分，当前余额 ${balance} 积分不足，请先充值。`,
              freeRemaining: 0,
              pointsNeeded,
              balance,
            });
            return;
          }
          // 积分充足，扣费后继续
          const callId = randomUUID();
          ledger.charge(accountId, pointsNeeded, {
            billing: "detection",
            callId,
            type: "text_detection",
            charLen,
            pointsCharged: pointsNeeded,
          });
          detectionChargedPoints = pointsNeeded;
        } else {
          throw quotaErr;
        }
      }

      log.info("Text upload: split paragraphs", {
        accountId,
        paragraphCount: paragraphTexts.length,
        totalChars: body.text.length,
        freeRemaining: getFreeTextCharsRemaining(accountId),
        detectionChargedPoints,
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
        // 免费额度剩余量，供前端实时更新配额显示
        freeRemaining: getFreeTextCharsRemaining(accountId),
        // 若免费额度已耗尽改为积分扣费，告知前端消耗了多少积分
        detectionChargedPoints: detectionChargedPoints > 0 ? detectionChargedPoints : undefined,
      });

      startBackgroundCnkiJudgeReview({
        logger: log,
        store: params.store,
        sessionId: session.sessionId,
        reportBefore,
        label: "Text upload",
      });
    })
  );
}

