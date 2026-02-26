import { randomUUID } from "node:crypto";

/**
 * 会话内保存一次上传的文档与分析结果。
 *
 * 设计原因：
 * - AIGC 检测与改写通常需要多步交互（先看报告，再选择段落应用改写，最后导出）。
 * - 为了“可运行”与简单部署，本项目默认使用内存存储（不落盘）。
 * 注意：
 * - 这不适合多实例/重启后持久化。如果后续需要，可替换为 SQLite/Redis，并保持同样的接口即可。
 */
export type SessionRecord = {
  sessionId: string;
  createdAt: number;
  filename: string;
  originalDocx: Buffer;

  /** 原文抽取的段落（后续解析器会填充） */
  paragraphs?: Array<{
    id: string;
    index: number;
    text: string;
    kind: "paragraph" | "tableCellParagraph";
  }>;

  /** 检测报告（后续分析器会填充） */
  reportBefore?: unknown;
  reportAfter?: unknown;

  /** 改写后的段落内容（key=paragraphId） */
  revised?: Record<string, string>;

  /** 改写结果与解释（key=paragraphId） */
  rewriteResults?: Record<
    string,
    {
      revisedText: string;
      changeRationale: string[];
      riskSignalsResolved: string[];
      needHumanCheck: string[];
      humanFeatures?: string[];
      chargedPoints: number;
      createdAt: number;
    }
  >;

  /** 聊天式改写的对话记录（按段落分组，按时间排序） */
  chatMessages?: Array<{
    id: string;
    role: "user" | "assistant";
    paragraphId: string;
    content: string;
    /** AI 回复时附带的改写建议（仅 role=assistant 时存在） */
    revisedText?: string;
    /** 本次 LLM 调用消耗的点数（仅 role=assistant 时存在） */
    chargedPoints?: number;
    timestamp: number;
  }>;

  /** 修订版 docx（回写后生成） */
  revisedDocx?: Buffer;

  /** 修订版 docx 对应的 revision */
  revisedDocxRevision?: number;

  /** 每次改写后自增，用于判断导出是否需要重新回写 */
  revision?: number;
};

export type SessionIndexItem = {
  sessionId: string;
  createdAt: number;
  filename: string;
  revision: number;
  hasRevised: boolean;
  overallBefore?: { score: number; level: string } | null;
  overallAfter?: { score: number; level: string } | null;
};

export type SessionStore = {
  create(params: { filename: string; originalDocx: Buffer }): SessionRecord;
  get(sessionId: string): SessionRecord | undefined;
  update(sessionId: string, patch: Partial<SessionRecord>): SessionRecord;
  list(limit?: number): SessionIndexItem[];
};

export class InMemorySessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  create(params: { filename: string; originalDocx: Buffer }): SessionRecord {
    const sessionId = randomUUID();
    const rec: SessionRecord = {
      sessionId,
      createdAt: Date.now(),
      filename: params.filename,
      originalDocx: params.originalDocx,
      revised: {},
      rewriteResults: {},
      revision: 0,
    };
    this.sessions.set(sessionId, rec);
    return rec;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  update(sessionId: string, patch: Partial<SessionRecord>): SessionRecord {
    const cur = this.sessions.get(sessionId);
    if (!cur) throw new Error(`Session not found: ${sessionId}`);
    const next = { ...cur, ...patch };
    this.sessions.set(sessionId, next);
    return next;
  }

  list(limit = 50): SessionIndexItem[] {
    const items: SessionIndexItem[] = [];
    for (const s of this.sessions.values()) {
      items.push({
        sessionId: s.sessionId,
        createdAt: s.createdAt,
        filename: s.filename,
        revision: s.revision ?? 0,
        hasRevised: Boolean(s.revised && Object.keys(s.revised).length),
        overallBefore: pickOverall(s.reportBefore),
        overallAfter: pickOverall(s.reportAfter),
      });
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items.slice(0, limit);
  }
}

function pickOverall(report: unknown): { score: number; level: string } | null {
  if (!report || typeof report !== "object") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = report as any;
  if (typeof r.overallRiskScore !== "number" || typeof r.overallRiskLevel !== "string") return null;
  return { score: r.overallRiskScore, level: r.overallRiskLevel };
}

