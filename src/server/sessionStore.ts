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
    kind: "paragraph" | "tableCellParagraph" | "imageParagraph";
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
      /**
       * 改写质量评估信息（可选）。
       *
       * 设计原因：
       * - 用户常见反馈是“改写后再次检测分数没变”，需要在服务端识别“改写太像原文/降分不明显”的情况；
       * - 该字段用于前端/日志展示与排障，不参与计费与导出逻辑，保持向后兼容。
       */
      quality?: {
        riskBefore: number;
        riskAfter: number;
        similarity: number;
        retryUsed: boolean;
        /**
         * 本次 LLM 调用 usage（如服务端返回）。
         * 用于核算 token 与积分关系，不参与检测/导出逻辑。
         */
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      };
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

  /**
   * 自动降分任务状态（用于前端展示真实进度）。
   *
   * 设计原因：
   * - 自动降分是长任务，前端不能只靠“伪进度条”；
   * - 将任务状态写入会话存储，可被轮询查询，且磁盘模式下可跨刷新保留。
   */
  autoRewriteJob?: {
    jobId: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    createdAt: number;
    updatedAt: number;
    finishedAt?: number;
    params: {
      targetScore: number;
      maxRounds: number;
      perRound: number;
      maxTotal: number;
      minParagraphScore: number;
      maxPerParagraph: number;
      stopNoImproveRounds: number;
      /**
       * 是否允许“事实风险模式”。
       *
       * 设计原因：
       * - 默认严格护栏，宁可少改也不编造；
       * - 用户明确选择继续时，可允许改写更激进，但需要强提示“需人工核对事实”。
       */
      allowFactRisk?: boolean;
      /**
       * 优先处理的段落（通常来自上一次被护栏拦截的段落）。
       * 设计原因：让“继续尝试”能更聚焦，而不是重复改已改完的部分。
       */
      preferParagraphIds?: string[];
    };
    progress: {
      roundsUsed: number;
      /**
       * 已处理（已尝试）段落数：包含成功与失败。
       * 设计原因：失败段落同样消耗时间，用户需要看到进度在走，而不是卡住。
       */
      processed: number;
      maxTotal: number;
      /** 成功改写的段落数（可选，用于更直观的进度反馈） */
      succeeded?: number;
      /** 失败/被拦截的段落数（可选，用于更直观的进度反馈） */
      failed?: number;
      overallBefore?: number;
      overallCurrent?: number;
      currentParagraphId?: string;
      currentParagraphIndex?: number;
      lastMessage?: string;
    };
    /**
     * 任务内的逐段失败信息（不中断整体任务）。
     *
     * 设计原因：
     * - 对用户来说“能改的先改掉”比“整单失败”更可接受；
     * - 把失败原因透明化，便于用户手动修订或选择继续（带风险提示）。
     */
    failures?: Array<{
      paragraphId: string;
      paragraphIndex?: number;
      code: string;
      message: string;
    }>;
    error?: { code?: string; message: string };
  };
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

