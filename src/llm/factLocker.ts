export type FactLockItem = {
  id: string;
  placeholder: string;
  value: string;
  kind: "number" | "date" | "citation" | "url" | "entity";
};

export type FactLockResult = {
  maskedText: string;
  items: FactLockItem[];
};

/**
 * 将段落中的“事实锚点”替换为占位符，供大模型做结构级重写时保持事实不变。
 *
 * 设计原因：
 * - 默认严格不编造事实：数字/日期/引用一旦被改动会造成论文失真；
 * - 先锁定事实锚点，再允许更激进的结构重写，可以同时提升降幅与合规性；
 * - 相比“事后护栏拦截”，事前锁定能显著降低失败率与用户等待成本。
 *
 * 实现方式（第一版，偏保守）：
 * - 抽取并锁定：数字/百分比/区间、日期/年份、引用标记、URL/DOI
 * - 使用形如 `⟦F1⟧` 的占位符，提示词要求“必须原样保留”
 *
 * 注意：
 * - 本模块并不试图做完整 NER；地点/机构等在第一版仍由 rewriteGuard 兜底。
 */
export function lockFacts(text: string): FactLockResult {
  const raw = String(text ?? "");
  if (!raw.trim()) return { maskedText: raw, items: [] };

  const items: FactLockItem[] = [];
  let masked = raw;

  const add = (kind: FactLockItem["kind"], value: string) => {
    const id = `F${items.length + 1}`;
    const placeholder = `⟦${id}⟧`;
    items.push({ id, placeholder, value, kind });
    return placeholder;
  };

  /**
   * 以“先长后短”防止局部覆盖（例如 2024-04-12 中的 2024）。
   * 这里统一收集命中，再做一次性替换，保证稳定。
   */
  const matches: Array<{ start: number; end: number; value: string; kind: FactLockItem["kind"] }> = [];

  for (const m of findAll(raw, /\bhttps?:\/\/[^\s)）\]】]+/g)) {
    matches.push({ start: m.index, end: m.index + m.value.length, value: m.value, kind: "url" });
  }
  for (const m of findAll(raw, /\bdoi:\s*[^\s)）\]】]+/gi)) {
    matches.push({ start: m.index, end: m.index + m.value.length, value: m.value, kind: "url" });
  }

  // [1] / [12]
  for (const m of findAll(raw, /\[\s*\d{1,3}\s*\]/g)) {
    matches.push({ start: m.index, end: m.index + m.value.length, value: m.value, kind: "citation" });
  }
  // （作者，年份）/ (Author, 2020) —— 只锁定括号整体，避免引用位置错乱
  for (const m of findAll(raw, /[（(][^（）()]{1,40}?(?:19|20)\d{2}[^（）()]{0,20}?[）)]/g)) {
    matches.push({ start: m.index, end: m.index + m.value.length, value: m.value, kind: "citation" });
  }
  // 图1 / 表2 / 式(3)
  for (const m of findAll(raw, /(?:图|表|式)\s*\(?\d{1,3}\)?/g)) {
    matches.push({ start: m.index, end: m.index + m.value.length, value: m.value, kind: "citation" });
  }

  // 2024年4月12日 / 2024年4月 / 2024-04-12 / 2024年
  for (const m of findAll(raw, /\b\d{4}\s*年\s*\d{1,2}\s*月\s*(?:\d{1,2}\s*日)?/g)) {
    matches.push({ start: m.index, end: m.index + m.value.length, value: m.value, kind: "date" });
  }
  for (const m of findAll(raw, /\b\d{4}-\d{1,2}-\d{1,2}\b/g)) {
    matches.push({ start: m.index, end: m.index + m.value.length, value: m.value, kind: "date" });
  }
  for (const m of findAll(raw, /\b(?:19|20)\d{2}\s*年\b/g)) {
    matches.push({ start: m.index, end: m.index + m.value.length, value: m.value, kind: "date" });
  }

  // 数字/百分比/区间（尽量排除年份已被 date 处理的部分，后续靠“重叠消解”解决）
  for (const m of findAll(raw, /\b\d+(?:\.\d+)?%?\b|\b\d+\s*-\s*\d+\b/g)) {
    matches.push({ start: m.index, end: m.index + m.value.length, value: m.value, kind: "number" });
  }

  // 地点/机构等“专名锚点”（第一版：启发式锁定原文已有专名，防止被改动或迁移）
  for (const m of findAll(raw, /[\u4e00-\u9fff]{2,6}(?:省|市|区|县|镇|乡|街|路|大道|巷|港|站|桥|河|湖|山)/g)) {
    matches.push({ start: m.index, end: m.index + m.value.length, value: m.value, kind: "entity" });
  }
  for (const m of findAll(raw, /[\u4e00-\u9fff]{2,10}(?:大学|学院|研究院|研究所|公司|集团|委员会|协会|中心)/g)) {
    matches.push({ start: m.index, end: m.index + m.value.length, value: m.value, kind: "entity" });
  }

  // 去重 + 去重叠：按长度降序，优先保留更长的片段
  const uniq = uniqueBy(matches, (x) => `${x.start}:${x.end}:${x.value}:${x.kind}`).sort(
    (a, b) => b.value.length - a.value.length || a.start - b.start
  );
  const picked: typeof uniq = [];
  for (const m of uniq) {
    if (picked.some((p) => rangesOverlap(p.start, p.end, m.start, m.end))) continue;
    picked.push(m);
  }
  picked.sort((a, b) => a.start - b.start);

  // 执行替换（从后往前）
  for (let i = picked.length - 1; i >= 0; i -= 1) {
    const m = picked[i];
    const placeholder = add(m.kind, m.value);
    masked = masked.slice(0, m.start) + placeholder + masked.slice(m.end);
  }

  return { maskedText: masked, items };
}

/**
 * 将改写文本中的占位符还原为原始事实锚点。
 *
 * 约束：
 * - 若占位符被删除/篡改，则视为不可安全还原（上层应当重试或标记失败段落）。
 */
export function restoreFacts(params: { text: string; items: FactLockItem[] }) {
  let out = String(params.text ?? "");
  for (const it of params.items) {
    out = out.split(it.placeholder).join(it.value);
  }
  return out;
}

/** 校验输出是否完整保留了所有占位符（数量与内容都一致） */
export function validatePlaceholders(params: { text: string; items: FactLockItem[] }):
  | { ok: true }
  | { ok: false; missing: string[] } {
  const s = String(params.text ?? "");
  const missing = params.items.map((x) => x.placeholder).filter((p) => !s.includes(p));
  return missing.length ? { ok: false, missing } : { ok: true };
}

function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return Math.max(a0, b0) < Math.min(a1, b1);
}

function uniqueBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    const k = key(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function findAll(s: string, re: RegExp): Array<{ index: number; value: string }> {
  const out: Array<{ index: number; value: string }> = [];
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = r.exec(s))) {
    out.push({ index: m.index, value: m[0] });
    if (m[0].length === 0) r.lastIndex += 1;
  }
  return out;
}

