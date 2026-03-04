import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * 兑换码系统（RedeemCode）
 *
 * 设计原因：
 * - 适配小红书等社交平台的"先付款→发码→用户兑换"销售模式；
 * - 无需集成第三方支付 SDK，管理员在后台批量生成码后通过私信分发给付款用户；
 * - 兑换码格式：8位大写字母+数字（去除易混淆字符 0/O/1/I），便于用户手动输入。
 *
 * 存储方式：JSON 文件（data/redeem-codes.json），与账本同目录。
 * 线程安全：单进程读写，适合 Zeabur/本地部署场景。
 */

export type RedeemCode = {
  /** 码值，8位大写字母数字（去除0/O/1/I） */
  code: string;
  /** 此码对应的积分数 */
  points: number;
  /** 创建时间（时间戳ms） */
  createdAt: number;
  /** 所属套餐名称，方便管理员区分 */
  packageName: string;
  /** 是否已使用 */
  used: boolean;
  /** 使用时间（时间戳ms），未使用时为 undefined */
  usedAt?: number;
  /** 使用者的 accountId，未使用时为 undefined */
  usedBy?: string;
};

type CodesFileState = {
  codes: RedeemCode[];
};

/** 生成码时排除易混淆字符 */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;

/** 生成单个兑换码 */
function genCode(): string {
  const bytes = randomBytes(CODE_LEN);
  return Array.from(bytes)
    .map((b) => CODE_CHARS[b % CODE_CHARS.length])
    .join("");
}

export class RedeemCodeStore {
  private readonly filePath: string;
  private state: CodesFileState;

  constructor(params: { dataDir: string }) {
    this.filePath = path.join(params.dataDir, "redeem-codes.json");
    fs.mkdirSync(params.dataDir, { recursive: true });
    this.state = this.load();
  }

  /**
   * 批量生成兑换码。
   * @param packageName 套餐名称，如"体验包 ¥9.9"
   * @param points 每码对应积分数
   * @param count 生成数量（最大 200 个）
   * @returns 生成的码列表
   */
  generate(packageName: string, points: number, count: number): RedeemCode[] {
    if (count < 1 || count > 200) throw new Error("count 必须在 1~200 之间");
    if (points < 1) throw new Error("points 必须 >= 1");

    const existingCodes = new Set(this.state.codes.map((c) => c.code));
    const newCodes: RedeemCode[] = [];
    let attempts = 0;

    while (newCodes.length < count) {
      if (attempts++ > count * 20) throw new Error("生成码失败（碰撞过多），请重试");
      const code = genCode();
      if (existingCodes.has(code)) continue;
      existingCodes.add(code);
      newCodes.push({
        code,
        points,
        createdAt: Date.now(),
        packageName,
        used: false,
      });
    }

    this.state.codes.push(...newCodes);
    this.persist();
    return newCodes;
  }

  /**
   * 兑换码核销：验证码值并标记为已用，返回积分数。
   * 错误时抛出含 code 字段的 Error，供上层判断。
   */
  redeem(code: string, accountId: string): { points: number; packageName: string } {
    const normalized = code.trim().toUpperCase();
    const entry = this.state.codes.find((c) => c.code === normalized);

    if (!entry) {
      const err = new Error("兑换码不存在或格式有误，请检查后重试");
      (err as NodeJS.ErrnoException).code = "CODE_NOT_FOUND";
      throw err;
    }
    if (entry.used) {
      const usedTime = entry.usedAt
        ? new Date(entry.usedAt).toLocaleString("zh-CN")
        : "未知时间";
      const err = new Error(`此兑换码已于 ${usedTime} 被使用`);
      (err as NodeJS.ErrnoException).code = "CODE_ALREADY_USED";
      throw err;
    }

    entry.used = true;
    entry.usedAt = Date.now();
    entry.usedBy = accountId;
    this.persist();

    return { points: entry.points, packageName: entry.packageName };
  }

  /** 列出所有兑换码（供管理员查看） */
  listAll(): RedeemCode[] {
    return [...this.state.codes].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 统计：已用/未用数量 */
  stats(): { total: number; used: number; unused: number } {
    const total = this.state.codes.length;
    const used = this.state.codes.filter((c) => c.used).length;
    return { total, used, unused: total - used };
  }

  private load(): CodesFileState {
    try {
      if (!fs.existsSync(this.filePath)) return { codes: [] };
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as CodesFileState;
      return { codes: parsed.codes ?? [] };
    } catch {
      return { codes: [] };
    }
  }

  private persist() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
  }
}
