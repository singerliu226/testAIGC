import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileLedger, FREE_TEXT_CHARS_QUOTA } from "./fileLedger.js";
import { RedeemCodeStore } from "./redeemCode.js";
import { AdminAuditLog } from "./adminAuditLog.js";

export { FREE_TEXT_CHARS_QUOTA };

function resolveDataDir(): string {
  const env = process.env.DATA_DIR?.trim();
  if (env) return env;
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "../../data");
}

const dataDir = resolveDataDir();

export const ledger = new FileLedger({ dataDir });

/** 兑换码仓库单例 */
export const redeemStore = new RedeemCodeStore({ dataDir });

/** 管理员操作审计日志单例 */
export const auditLog = new AdminAuditLog({ dataDir });

export function getAccountIdFromRequestHeader(headerVal: unknown): string {
  const v = typeof headerVal === "string" ? headerVal.trim() : "";
  return v || "local";
}

export function getDefaultFreePoints(): number {
  const n = Number(process.env.DEFAULT_FREE_POINTS ?? "0");
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * 判断是否为管理员账号。
 * 管理员账号在请求头 `x-admin-secret` 中携带正确的 ADMIN_SECRET 即可。
 */
export function isAdminRequest(adminSecretHeader: unknown): boolean {
  const secret = process.env.ADMIN_SECRET?.trim();
  if (!secret) return false;
  return typeof adminSecretHeader === "string" && adminSecretHeader.trim() === secret;
}

/**
 * 验证管理员密钥是否正确。
 */
export function verifyAdminSecret(secret: string): boolean {
  const expected = process.env.ADMIN_SECRET?.trim();
  if (!expected) return false;
  return secret === expected;
}

/**
 * 列出所有账号（供管理员面板使用）。
 */
export function listAllAccounts() {
  return ledger.listAllAccounts();
}

/**
 * 返回账号当前余额与文字粘贴免费额度剩余量，供 GET /api/account/info 路由使用。
 */
export function getAccountInfo(accountId: string): {
  balance: number;
  freeTextRemaining: number;
} {
  return {
    balance: ledger.getBalance(accountId),
    freeTextRemaining: ledger.getFreeTextCharsRemaining(accountId),
  };
}

/**
 * 消耗免费文字粘贴检测额度（透传 ledger 实例方法，保持路由层依赖 index.ts 单入口）。
 */
export function consumeFreeTextChars(accountId: string, n: number): void {
  ledger.consumeFreeTextChars(accountId, n);
}

/**
 * 返回账号剩余免费文字检测字数。
 */
export function getFreeTextCharsRemaining(accountId: string): number {
  return ledger.getFreeTextCharsRemaining(accountId);
}

