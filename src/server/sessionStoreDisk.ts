import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionRecord, SessionIndexItem, SessionStore } from "./sessionStore.js";

export type DiskSessionStoreOptions = {
  dataDir: string;
};

/**
 * 磁盘会话存储（本地单机）。
 *
 * 设计原因：
 * - 毕业季用户最怕“改到一半关了网页全没了”；
 * - 混合形态强调隐私：把全文与修订版都保存在用户本机，而不是你的云端数据库。
 *
 * 实现方式：
 * - `dataDir/sessions/<sessionId>/state.json`：会话元数据（不含大文件）
 * - `dataDir/sessions/<sessionId>/original.docx`：原文
 * - `dataDir/sessions/<sessionId>/revised.docx`：修订版（可选）
 * - 内存缓存 Map：减少频繁 IO。
 *
 * 注意：
 * - 这不是多进程安全存储；并发写入需加锁或换数据库。
 */
export class DiskSessionStore implements SessionStore {
  private readonly root: string;
  private readonly cache = new Map<string, SessionRecord>();

  constructor(opts: DiskSessionStoreOptions) {
    this.root = path.join(opts.dataDir, "sessions");
    fs.mkdirSync(this.root, { recursive: true });
  }

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
    this.cache.set(sessionId, rec);
    this.persist(rec);
    this.persistDocx(sessionId, "original.docx", params.originalDocx);
    return rec;
  }

  get(sessionId: string): SessionRecord | undefined {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    const loaded = this.load(sessionId);
    if (loaded) this.cache.set(sessionId, loaded);
    return loaded;
  }

  update(sessionId: string, patch: Partial<SessionRecord>): SessionRecord {
    const cur = this.get(sessionId);
    if (!cur) throw new Error(`Session not found: ${sessionId}`);
    const next: SessionRecord = { ...cur, ...patch };
    this.cache.set(sessionId, next);
    this.persist(next);
    if (patch.originalDocx) this.persistDocx(sessionId, "original.docx", patch.originalDocx);
    if (patch.revisedDocx) this.persistDocx(sessionId, "revised.docx", patch.revisedDocx);
    return next;
  }

  list(limit = 50): SessionIndexItem[] {
    const dirs = safeReadDir(this.root)
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const items: SessionIndexItem[] = [];
    for (const sid of dirs) {
      const statePath = path.join(this.root, sid, "state.json");
      if (!fs.existsSync(statePath)) continue;
      try {
        const raw = fs.readFileSync(statePath, "utf-8");
        const s = JSON.parse(raw) as SessionRecord;
        items.push({
          sessionId: s.sessionId,
          createdAt: s.createdAt,
          filename: s.filename,
          revision: s.revision ?? 0,
          hasRevised: Boolean(s.revised && Object.keys(s.revised).length),
          overallBefore: pickOverall(s.reportBefore),
          overallAfter: pickOverall(s.reportAfter),
        });
      } catch {
        // ignore broken items
      }
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items.slice(0, limit);
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.root, sessionId);
  }

  private persist(rec: SessionRecord) {
    const dir = this.sessionDir(rec.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const statePath = path.join(dir, "state.json");

    // 避免把大 buffer 写进 state.json
    const { originalDocx, revisedDocx, ...rest } = rec;
    fs.writeFileSync(statePath, JSON.stringify(rest, null, 2), "utf-8");
  }

  private persistDocx(sessionId: string, filename: "original.docx" | "revised.docx", buf: Buffer) {
    const dir = this.sessionDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), buf);
  }

  private load(sessionId: string): SessionRecord | undefined {
    const dir = this.sessionDir(sessionId);
    const statePath = path.join(dir, "state.json");
    const originalPath = path.join(dir, "original.docx");
    if (!fs.existsSync(statePath) || !fs.existsSync(originalPath)) return undefined;
    try {
      const raw = fs.readFileSync(statePath, "utf-8");
      const rest = JSON.parse(raw) as Omit<SessionRecord, "originalDocx">;
      const originalDocx = fs.readFileSync(originalPath);
      const revisedPath = path.join(dir, "revised.docx");
      const revisedDocx = fs.existsSync(revisedPath) ? fs.readFileSync(revisedPath) : undefined;
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(rest as any),
        originalDocx,
        revisedDocx,
      } as SessionRecord;
    } catch {
      return undefined;
    }
  }
}

function safeReadDir(dir: string): Array<fs.Dirent> {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function pickOverall(report: unknown): { score: number; level: string } | null {
  if (!report || typeof report !== "object") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = report as any;
  if (typeof r.overallRiskScore !== "number" || typeof r.overallRiskLevel !== "string") return null;
  return { score: r.overallRiskScore, level: r.overallRiskLevel };
}

