import type { LedgerTx } from "./fileLedger.js";

export type UsageReport = {
  generatedAt: number;
  rangeDays: number;
  packages: Array<{
    name: string;
    priceYuan: number;
    points: number;
    yuanPerPoint: number;
  }>;
  pricingHint: {
    /** 以不同套餐折算的“每积分成本”范围（元/积分） */
    yuanPerPointRange: { min: number; max: number };
  };
  totals: {
    calls: number;
    pointsCharged: number;
    pointsRefunded: number;
    pointsNet: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    tokensPerPoint: number | null;
    costYuanRange: { min: number; max: number } | null;
  };
  byType: Record<
    string,
    {
      calls: number;
      pointsNet: number;
      totalTokens: number;
      tokensPerPoint: number | null;
      costYuanRange: { min: number; max: number } | null;
    }
  >;
  autoTo15: {
    sessions: number;
    avgPointsPerSession: number | null;
    medianPointsPerSession: number | null;
    costYuanRangeAvgSession: { min: number; max: number } | null;
  };
};

/**
 * 从账本交易中生成 token/积分核算报表。
 *
 * 设计原因：
 * - 产品需要“算清楚 tokens 和对应积分”，才能判断收费是否要调整；
 * - 账本是追加事务模型，统计应通过 meta 字段来重建“每次调用”的实际消耗。
 *
 * 约定：
 * - 只统计 meta.billing === "llm" 的 CHARGE/REFUND；
 * - pointsNet = 负向 CHARGE + 正向 REFUND 的代数和（取绝对值便于展示）；
 * - tokens 取 meta.usage.totalTokens 汇总（按调用维度去重）。
 */
export function buildUsageReport(params: { txs: LedgerTx[]; rangeDays: number }): UsageReport {
  const now = Date.now();
  const since = now - params.rangeDays * 24 * 60 * 60 * 1000;

  const relevant = params.txs.filter((t) => t.createdAt >= since && t.meta && (t.meta as any).billing === "llm");

  // 以 callId 去重 tokens（同一次调用可能有 CHARGE + REFUND/EXTRA_CHARGE）
  const callTokens = new Map<string, { total: number; prompt: number; completion: number; type: string }>();

  let pointsCharged = 0;
  let pointsRefunded = 0;
  const byTypeAgg = new Map<string, { calls: number; pointsNet: number; totalTokens: number }>();
  const autoSessionPoints = new Map<string, number>();

  for (const t of relevant) {
    const meta = t.meta as any;
    const type = String(meta.type ?? "unknown");
    const callId = String(meta.callId ?? t.txId);
    const sessionId = typeof meta.sessionId === "string" ? meta.sessionId : "";

    if (t.delta < 0) pointsCharged += Math.abs(t.delta);
    if (t.delta > 0) pointsRefunded += t.delta;

    const usage = meta.usage;
    if (usage && typeof usage.totalTokens === "number") {
      if (!callTokens.has(callId)) {
        callTokens.set(callId, {
          total: Math.max(0, Math.floor(usage.totalTokens)),
          prompt: Math.max(0, Math.floor(usage.promptTokens ?? 0)),
          completion: Math.max(0, Math.floor(usage.completionTokens ?? 0)),
          type,
        });
      }
    }

    const cur = byTypeAgg.get(type) ?? { calls: 0, pointsNet: 0, totalTokens: 0 };
    cur.pointsNet += -t.delta; // CHARGE(负)计为正成本，REFUND(正)计为负成本
    byTypeAgg.set(type, cur);

    // 按 session 聚合 auto（近似“每次一键降到15%”的成本，用户视角最直观）
    if (type === "auto" && sessionId) {
      autoSessionPoints.set(sessionId, (autoSessionPoints.get(sessionId) ?? 0) + -t.delta);
    }
  }

  // 统计 calls/tokens 按 callTokens 维度
  const totalsTokens = Array.from(callTokens.values()).reduce(
    (acc, u) => {
      acc.total += u.total;
      acc.prompt += u.prompt;
      acc.completion += u.completion;
      return acc;
    },
    { total: 0, prompt: 0, completion: 0 }
  );

  // 给 byType 写入 calls/tokens
  for (const u of callTokens.values()) {
    const cur = byTypeAgg.get(u.type) ?? { calls: 0, pointsNet: 0, totalTokens: 0 };
    cur.calls += 1;
    cur.totalTokens += u.total;
    byTypeAgg.set(u.type, cur);
  }

  const pointsNet = pointsCharged - pointsRefunded;
  const tokensPerPoint = pointsNet > 0 ? totalsTokens.total / pointsNet : null;

  const packages = defaultPackages();
  const yuanPerPointRange = packages.length
    ? {
        min: Math.min(...packages.map((p) => p.yuanPerPoint)),
        max: Math.max(...packages.map((p) => p.yuanPerPoint)),
      }
    : { min: 0, max: 0 };

  const totalsCostYuanRange =
    pointsNet > 0
      ? {
          min: round2(pointsNet * yuanPerPointRange.min),
          max: round2(pointsNet * yuanPerPointRange.max),
        }
      : null;

  const byType: UsageReport["byType"] = {};
  for (const [type, v] of byTypeAgg) {
    const tpp = v.pointsNet > 0 ? v.totalTokens / v.pointsNet : null;
    const cost =
      v.pointsNet > 0
        ? {
            min: round2(v.pointsNet * yuanPerPointRange.min),
            max: round2(v.pointsNet * yuanPerPointRange.max),
          }
        : null;
    byType[type] = {
      calls: v.calls,
      pointsNet: v.pointsNet,
      totalTokens: v.totalTokens,
      tokensPerPoint: tpp,
      costYuanRange: cost,
    };
  }

  const autoSessions = Array.from(autoSessionPoints.values())
    .map((x) => Math.max(0, x))
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const avgAuto = autoSessions.length
    ? autoSessions.reduce((a, b) => a + b, 0) / autoSessions.length
    : null;
  const medianAuto = autoSessions.length ? median(autoSessions) : null;
  const autoAvgCost =
    avgAuto !== null
      ? {
          min: round2(avgAuto * yuanPerPointRange.min),
          max: round2(avgAuto * yuanPerPointRange.max),
        }
      : null;

  return {
    generatedAt: now,
    rangeDays: params.rangeDays,
    packages,
    pricingHint: { yuanPerPointRange },
    totals: {
      calls: callTokens.size,
      pointsCharged,
      pointsRefunded,
      pointsNet,
      totalTokens: totalsTokens.total,
      promptTokens: totalsTokens.prompt,
      completionTokens: totalsTokens.completion,
      tokensPerPoint,
      costYuanRange: totalsCostYuanRange,
    },
    byType,
    autoTo15: {
      sessions: autoSessions.length,
      avgPointsPerSession: avgAuto !== null ? round2(avgAuto) : null,
      medianPointsPerSession: medianAuto !== null ? round2(medianAuto) : null,
      costYuanRangeAvgSession: autoAvgCost,
    },
  };
}

function defaultPackages(): Array<{ name: string; priceYuan: number; points: number; yuanPerPoint: number }> {
  // 与前端定价弹窗保持一致（不从 HTML 解析，避免耦合）
  const pkgs = [
    { name: "体验包", priceYuan: 9.9, points: 100 },
    { name: "基础包", priceYuan: 29.9, points: 400 },
    { name: "旗舰包", priceYuan: 79.9, points: 1200 },
  ];
  return pkgs.map((p) => ({ ...p, yuanPerPoint: p.points ? p.priceYuan / p.points : 0 }));
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

