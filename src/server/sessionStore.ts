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
  /**
   * 所有者账号 ID（来自前端 x-account-id 请求头）。
   * 设计原因：防止不同用户互相查看对方的历史记录，
   * list/get 接口均需校验此字段。
   */
  accountId: string;
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
   * 标记该会话来自纯文字粘贴入口（非 .docx 文件上传）。
   *
   * 设计原因：
   * - 文字粘贴用户没有原始 .docx 文件，改写完成后的导出方式与文件上传用户不同；
   * - 前端根据该标记切换按钮行为：文字会话显示"查看改写结果"（复制面板），
   *   文件会话显示"预览并下载论文"（docx 下载弹窗）。
   */
  isTextInput?: boolean;

  /**
   * 文档语言（后台解析完成后写入）。
   * 前端轮询 parseStatus 完成后据此决定是否显示英文检测提示。
   */
  isEnglish?: boolean;

  /**
   * 后台解析失败时记录错误信息。
   *
   * 设计原因：
   * - 上传接口已改为"立即响应 + 后台解析"，解析失败无法通过 HTTP 状态码传达；
   * - 前端轮询 /api/session/:sessionId 时检测此字段，若存在则展示错误并停止轮询。
   */
  parseError?: string;

  /**
   * 每个段落被成功改写的累计次数（跨多次任务）。
   *
   * 设计原因：
   * - 同一段落被反复尝试改写，若已超过阈值（如 3 次）仍无法有效降低风险，
   *   继续尝试往往只是消耗积分而收效甚微；
   * - 记录跨任务的累计次数，让系统自动跳过顽固段落，并在前端预检弹窗中
   *   提示用户"该部分建议手动处理"，做到透明且省钱。
   */
  paragraphRewriteCounts?: Record<string, number>;

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
      /** 最终有效保留的段落数（可选，用于更直观的进度反馈） */
      succeeded?: number;
      /** 失败/被拦截的段落数（可选，用于更直观的进度反馈） */
      failed?: number;
      /** 生成成功但未降分、因此被自动丢弃的段落数 */
      discarded?: number;
      overallBefore?: number;
      overallCurrent?: number;
      currentParagraphId?: string;
      currentParagraphIndex?: number;
      lastMessage?: string;
      /** 当 0 候选时记录的具体耗尽原因，前端可据此显示专属提示而非通用"完成" */
      exhaustedReason?: string;
      /** 若整轮回滚，记录回滚原因与数量，便于前端解释“为什么没保存” */
      rollbackApplied?: boolean;
      rollbackReason?: string;
      keptBeforeRollback?: number;
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
  overallCnkiBefore?: { score: number; level: string } | null;
  overallCnkiAfter?: { score: number; level: string } | null;
};

/** 管理员活跃看板用的轻量会话摘要（不含 Buffer 字段） */
export type SessionSummary = SessionIndexItem & {
  accountId: string;
  autoRewriteJob?: SessionRecord["autoRewriteJob"];
};

export type SessionStore = {
  create(params: { filename: string; originalDocx: Buffer; accountId: string }): SessionRecord;
  get(sessionId: string): SessionRecord | undefined;
  update(sessionId: string, patch: Partial<SessionRecord>): SessionRecord;
  /**
   * 列出指定账号的历史会话（按创建时间倒序）。
   * @param accountId 只返回该账号创建的会话
   * @param limit 最多返回条数，默认 30
   */
  list(accountId: string, limit?: number): SessionIndexItem[];
  /**
   * 管理员专用：列出所有账号的会话摘要（按创建时间倒序，无 accountId 过滤）。
   *
   * 设计原因：
   * - 普通 list() 仅返回指定账号的会话，无法用于跨账号的活跃看板统计；
   * - 此方法仅供 admin 路由调用，不对外暴露给普通用户接口。
   * - Disk 实现只读 state.json，不加载 docx Buffer，避免内存压力。
   * @param opts.sinceMs 只返回 createdAt >= sinceMs 的会话（用于 24h 统计）
   */
  listAllForAdmin(opts?: { sinceMs?: number }): SessionSummary[];
};

export class InMemorySessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  create(params: { filename: string; originalDocx: Buffer; accountId: string }): SessionRecord {
    const sessionId = randomUUID();
    const rec: SessionRecord = {
      sessionId,
      accountId: params.accountId,
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

  /**
   * 只返回属于指定账号的会话，确保用户间数据完全隔离。
   */
  list(accountId: string, limit = 50): SessionIndexItem[] {
    const items: SessionIndexItem[] = [];
    for (const s of this.sessions.values()) {
      if (s.accountId !== accountId) continue;
      items.push({
        sessionId: s.sessionId,
        createdAt: s.createdAt,
        filename: s.filename,
        revision: s.revision ?? 0,
        hasRevised: Boolean(s.revised && Object.keys(s.revised).length),
        overallBefore: pickOverall(s.reportBefore),
        overallAfter: pickOverall(s.reportAfter),
        overallCnkiBefore: pickCnkiOverall(s.reportBefore),
        overallCnkiAfter: pickCnkiOverall(s.reportAfter),
      });
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items.slice(0, limit);
  }

  /** 管理员专用：返回所有账号的会话摘要，含 autoRewriteJob 状态。 */
  listAllForAdmin(opts?: { sinceMs?: number }): SessionSummary[] {
    const since = opts?.sinceMs ?? 0;
    const items: SessionSummary[] = [];
    for (const s of this.sessions.values()) {
      if (s.createdAt < since) continue;
      items.push({
        sessionId: s.sessionId,
        accountId: s.accountId,
        createdAt: s.createdAt,
        filename: s.filename,
        revision: s.revision ?? 0,
        hasRevised: Boolean(s.revised && Object.keys(s.revised).length),
        overallBefore: pickOverall(s.reportBefore),
        overallAfter: pickOverall(s.reportAfter),
        overallCnkiBefore: pickCnkiOverall(s.reportBefore),
        overallCnkiAfter: pickCnkiOverall(s.reportAfter),
        autoRewriteJob: s.autoRewriteJob,
      });
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items;
  }
}

function pickOverall(report: unknown): { score: number; level: string } | null {
  if (!report || typeof report !== "object") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = report as any;
  if (typeof r.overallRiskScore !== "number" || typeof r.overallRiskLevel !== "string") return null;
  return { score: r.overallRiskScore, level: r.overallRiskLevel };
}

function pickCnkiOverall(report: unknown): { score: number; level: string } | null {
  if (!report || typeof report !== "object") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = report as any;
  if (
    typeof r.overallCnkiPredictedScore !== "number" ||
    typeof r.overallCnkiPredictedLevel !== "string"
  ) {
    return null;
  }
  return { score: r.overallCnkiPredictedScore, level: r.overallCnkiPredictedLevel };
}

