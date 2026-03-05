import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 管理员操作审计日志（AdminAuditLog）
 *
 * 设计原因：
 * - 管理员可执行充值、批量生成兑换码等高权限操作，需要留存完整操作记录；
 * - 当出现账号异常（如积分不明原因增减）时，审计日志是唯一的溯源依据；
 * - 记录客户端 IP，可识别是否存在异地操作或账号泄露风险。
 *
 * 存储：data/admin-audit.json，最多保留 1000 条，超出时滚动删除最旧记录。
 * 格式：JSON 数组，按时间正序排列（读取时倒序返回）。
 */

export type AuditEntry = {
  /** 记录唯一 ID */
  id: string;
  /** 操作时间（时间戳ms） */
  timestamp: number;
  /** 客户端 IP（经过 x-forwarded-for 处理） */
  ip: string;
  /** 操作类型标识，如 ADMIN_LOGIN / TOPUP / GENERATE_CODES / REDEEM_CODE 等 */
  action: string;
  /** 操作的附加结构化信息，如 accountId、points、code 数量 */
  details: Record<string, unknown>;
};

const MAX_ENTRIES = 1000;

export class AdminAuditLog {
  private readonly filePath: string;
  private entries: AuditEntry[];

  constructor(params: { dataDir: string }) {
    this.filePath = path.join(params.dataDir, "admin-audit.json");
    fs.mkdirSync(params.dataDir, { recursive: true });
    this.entries = this.load();
  }

  /**
   * 记录一条审计日志。
   * @param ip      客户端 IP
   * @param action  操作标识（大写下划线风格，如 GENERATE_CODES）
   * @param details 操作细节
   */
  record(
    ip: string,
    action: string,
    details: Record<string, unknown> = {}
  ): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      timestamp: Date.now(),
      ip,
      action,
      details,
    };

    this.entries.push(entry);

    // 超出上限时，删除最旧的记录（保持 MAX_ENTRIES 条）
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES);
    }

    this.persist();
    return entry;
  }

  /**
   * 返回最近的审计记录（倒序，最新在前）。
   * @param limit 最多返回条数，默认 100
   */
  list(limit = 100): AuditEntry[] {
    return [...this.entries]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /** 统计各操作类型的次数（用于管理员面板概览） */
  actionStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const e of this.entries) {
      stats[e.action] = (stats[e.action] ?? 0) + 1;
    }
    return stats;
  }

  private load(): AuditEntry[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private persist() {
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(this.entries, null, 2),
      "utf-8"
    );
  }
}
