import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileLedger } from "./fileLedger.js";

function resolveDataDir(): string {
  const env = process.env.DATA_DIR?.trim();
  if (env) return env;
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "../../data");
}

export const ledger = new FileLedger({ dataDir: resolveDataDir() });

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

