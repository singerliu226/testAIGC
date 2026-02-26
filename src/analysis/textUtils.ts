import nodejieba from "nodejieba";

export function normalizeText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

export function splitSentences(input: string): string[] {
  const text = normalizeText(input);
  if (!text) return [];
  // 简单中文断句：保留句尾标点作为边界
  const raw = text.split(/(?<=[。！？!?；;])\s*/g);
  return raw.map((s) => s.trim()).filter(Boolean);
}

/**
 * 中文分词（nodejieba）。
 *
 * 设计原因：
 * - 许多信号需要“词级统计”（多样性、重复 n-gram、抽象名词密度）。
 * - 不依赖在线服务，保证本地可运行。
 *
 * 实现方式：
 * - 优先使用 nodejieba；若失败则退化为“按字符/空白切分”的兜底策略。
 */
export function tokenizeZh(input: string): string[] {
  const text = normalizeText(input);
  if (!text) return [];
  try {
    // 过滤掉空白 token
    return nodejieba
      .cut(text, true)
      .map((t: string) => t.trim())
      .filter(Boolean);
  } catch {
    return text.split(/\s+/g).filter(Boolean);
  }
}

export function countOccurrences(text: string, needles: string[]): { count: number; hits: string[] } {
  let count = 0;
  const hits: string[] = [];
  for (const n of needles) {
    if (!n) continue;
    const re = new RegExp(escapeRegExp(n), "g");
    const m = text.match(re);
    if (m?.length) {
      count += m.length;
      hits.push(n);
    }
  }
  return { count, hits: unique(hits) };
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function variance(xs: number[]): number {
  if (xs.length <= 1) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
}

/**
 * 计算 token n-gram 的重复比例（0..1）。
 *
 * 设计原因：
 * - AIGC 文本常呈现“局部结构重复”（尤其在长段落中）；
 * - 用 n-gram 重复比例可以提供可解释、稳定的统计信号。
 */
export function ngramRepeatRatio(tokens: string[], n: number): number {
  if (tokens.length < n + 2) return 0;
  const grams: string[] = [];
  for (let i = 0; i <= tokens.length - n; i += 1) {
    grams.push(tokens.slice(i, i + n).join("_"));
  }
  const total = grams.length;
  const uniq = new Set(grams).size;
  return total ? clamp((total - uniq) / total, 0, 1) : 0;
}

