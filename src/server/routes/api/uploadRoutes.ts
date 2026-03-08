import type { Router } from "express";
import type { AppLogger } from "../../../logger/index.js";
import type { SessionStore } from "../../sessionStore.js";
import type multer from "multer";
import { parseDocx } from "../../../docx/parser.js";
import { detectAigcRisk } from "../../../analysis/detector.js";
import { judgeParagraphWithDashscope } from "../../../llm/judge.js";
import { asyncHandler } from "../asyncHandler.js";
import { uploadLimiter } from "../../rateLimit.js";
import { HttpError } from "../../errors.js";

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

      const session = params.store.create({
        filename: decodedFilename,
        originalDocx: file.buffer,
      });

      log.info("Uploaded docx", {
        sessionId: session.sessionId,
        filename: session.filename,
        size: file.size,
      });

      const parsed = await parseDocx(file.buffer);
      const paragraphs = parsed.paragraphs.map((p) => ({
        id: p.id,
        index: p.index,
        text: p.text,
        kind: p.kind,
      }));

      const reportBefore = detectAigcRisk(paragraphs);

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

      log.info("Parsed docx paragraphs", {
        sessionId: session.sessionId,
        paragraphCount: parsed.paragraphs.length,
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

