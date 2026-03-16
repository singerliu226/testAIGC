import nodejieba from "nodejieba";

export function normalizeText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

/**
 * 判断文本主体语言：统计非空白字符中 ASCII 字母占比。
 *
 * 设计原因：
 * - 同一逻辑原散落在 prompts.ts 的 buildRewriteMessages 内，属于内联函数，无法复用；
 * - 提取为公共工具后，detectAigcRiskAsync 与 rewriteGuard 均可直接调用，保持判断口径一致。
 * - 阈值 0.55：正文为英文的学术论文（含少量数字/标点）通常 >0.7，中文论文通常 <0.2，混合摘要约 0.4-0.6。
 */
export function detectTextLanguage(text: string): "zh" | "en" {
  const nonSpace = text.replace(/\s/g, "");
  if (!nonSpace) return "zh";
  const asciiLetters = (nonSpace.match(/[A-Za-z]/g) ?? []).length;
  return asciiLetters / nonSpace.length > 0.55 ? "en" : "zh";
}

/**
 * 判断一批段落的文档主体语言。
 *
 * 设计原因：
 * - 单段可能因标题/页眉误判语言，用所有段落的合并文本来判断更稳定。
 */
export function detectDocumentLanguage(paragraphs: Array<{ text: string }>): "zh" | "en" {
  const combined = paragraphs.map((p) => p.text).join(" ");
  return detectTextLanguage(combined);
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

