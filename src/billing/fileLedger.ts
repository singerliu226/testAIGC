import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type LedgerTx = {
  txId: string;
  accountId: string;
  delta: number; // +topup, -charge
  reason: string;
  createdAt: number;
  meta?: Record<string, unknown>;
};

export type LedgerAccount = {
  accountId: string;
  balance: number;
  createdAt: number;
  updatedAt: number;
};

type LedgerFileState = {
  accounts: Record<string, LedgerAccount>;
  transactions: LedgerTx[];
};

/**
 * 文件型点数账本（MVP）。
 *
 * 设计原因：
 * - 毕业季要快速上线“点数包”最小闭环，避免引入原生依赖（SQLite）带来的安装/部署风险；
 * - 通过“单文件 + 追加事务”的方式，能做到可恢复、可审计、可迁移。
 * 实现方式：
 * - `accounts` 保存余额；
 * - `transactions` 追加记录（用于对账与客服）。
 *
 * 注意：
 * - 单进程本地使用没问题；多进程/并发高场景需要加锁或换数据库。
 */
export class FileLedger {
  private readonly filePath: string;
  private state: LedgerFileState;

  constructor(params: { dataDir: string; filename?: string }) {
    const filename = params.filename ?? "billing-ledger.json";
    this.filePath = path.join(params.dataDir, filename);
    fs.mkdirSync(params.dataDir, { recursive: true });
    this.state = this.load();
  }

  ensureAccount(accountId: string, initialBalance: number): LedgerAccount {
    const now = Date.now();
    const cur = this.state.accounts[accountId];
    if (cur) return cur;
    const acc: LedgerAccount = {
      accountId,
      balance: Math.max(0, Math.floor(initialBalance)),
      createdAt: now,
      updatedAt: now,
    };
    this.state.accounts[accountId] = acc;
    this.persist();
    return acc;
  }

  getBalance(accountId: string): number {
    return this.state.accounts[accountId]?.balance ?? 0;
  }

  listAllAccounts(): LedgerAccount[] {
    return Object.values(this.state.accounts);
  }

  listTransactions(accountId: string, limit = 50): LedgerTx[] {
    const xs = this.state.transactions.filter((t) => t.accountId === accountId);
    return xs.slice(Math.max(0, xs.length - limit));
  }

  topup(accountId: string, points: number, meta?: Record<string, unknown>): LedgerTx {
    const p = Math.max(0, Math.floor(points));
    if (!p) throw new Error("Invalid topup points");
    return this.apply(accountId, +p, "TOPUP", meta);
  }

  charge(accountId: string, points: number, meta?: Record<string, unknown>): LedgerTx {
    const p = Math.max(0, Math.floor(points));
    if (!p) throw new Error("Invalid charge points");
    const bal = this.getBalance(accountId);
    if (bal < p) {
      const err = new Error("INSUFFICIENT_POINTS");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).code = "INSUFFICIENT_POINTS";
      throw err;
    }
    return this.apply(accountId, -p, "CHARGE", meta);
  }

  refund(accountId: string, points: number, meta?: Record<string, unknown>): LedgerTx {
    const p = Math.max(0, Math.floor(points));
    if (!p) throw new Error("Invalid refund points");
    return this.apply(accountId, +p, "REFUND", meta);
  }

  private apply(accountId: string, delta: number, reason: string, meta?: Record<string, unknown>): LedgerTx {
    const now = Date.now();
    const acc = this.state.accounts[accountId];
    if (!acc) throw new Error(`Account not found: ${accountId}`);

    const nextBalance = acc.balance + delta;
    if (nextBalance < 0) {
      const err = new Error("INSUFFICIENT_POINTS");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).code = "INSUFFICIENT_POINTS";
      throw err;
    }

    acc.balance = nextBalance;
    acc.updatedAt = now;

    const tx: LedgerTx = {
      txId: randomUUID(),
      accountId,
      delta,
      reason,
      createdAt: now,
      meta,
    };
    this.state.transactions.push(tx);
    this.persist();
    return tx;
  }

  private load(): LedgerFileState {
    try {
      if (!fs.existsSync(this.filePath)) {
        return { accounts: {}, transactions: [] };
      }
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as LedgerFileState;
      return {
        accounts: parsed.accounts ?? {},
        transactions: parsed.transactions ?? [],
      };
    } catch {
      // 损坏时降级为新账本（MVP）；生产应做备份与修复。
      return { accounts: {}, transactions: [] };
    }
  }

  private persist() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
  }
}

