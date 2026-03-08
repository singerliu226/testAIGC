export type RewriteGuardResult =
  | { ok: true }
  | { ok: false; violations: Array<{ ruleId: string; evidence: string }> };

export type RewriteGuardParams = {
  originalText: string;
  revisedText: string;
};

/**
 * 改写真实性护栏：阻止模型“为了更像人类”而编造事实锚点。
 *
 * 设计原因：
 * - 用户目标是降低 AI 检测风险，但论文场景里“新增具体时间/地点/样本/调研经历”等属于高风险伪造；
 * - 仅靠 prompt 约束不可靠：必须在服务端做可解释的校验与拦截。
 *
 * 实现方式：
 * - 对比原文与改写稿，检测改写稿中出现而原文未出现的“事实锚点”：
 *   - 数字/百分比/区间（阿拉伯数字）
 *   - 日期样式（YYYY年MM月DD日、YYYY-MM-DD 等）
 *   - 类地名片段（以 省/市/区/县/路/街/大道 等结尾的中文短语）
 *   - 研究过程宣称（问卷/访谈/实地/调研/笔者/本文调研 等）
 *
 * 注意：这是启发式规则，宁可偏严，避免“看似降分但内容失真”。
 */
export function validateRewriteGuard(params: RewriteGuardParams): RewriteGuardResult {
  const original = String(params.originalText ?? "");
  const revised = String(params.revisedText ?? "");

  if (!revised.trim()) {
    return { ok: false, violations: [{ ruleId: "empty_output", evidence: "改写结果为空" }] };
  }

  const violations: Array<{ ruleId: string; evidence: string }> = [];

  // 1) 新增数字/百分比/区间
  const numsOrig = new Set(extractNumberLike(original));
  const numsRev = unique(extractNumberLike(revised));
  const newNums = numsRev.filter((x) => !numsOrig.has(x));
  if (newNums.length) {
    violations.push({
      ruleId: "new_numbers",
      evidence: `新增数字/比例：${newNums.slice(0, 8).join("、")}`,
    });
  }

  // 2) 新增日期
  const datesOrig = new Set(extractDateLike(original));
  const datesRev = unique(extractDateLike(revised));
  const newDates = datesRev.filter((x) => !datesOrig.has(x));
  if (newDates.length) {
    violations.push({
      ruleId: "new_dates",
      evidence: `新增日期：${newDates.slice(0, 6).join("、")}`,
    });
  }

  // 3) 新增类地名
  const placesOrig = new Set(extractPlaceLike(original));
  const placesRev = unique(extractPlaceLike(revised));
  const newPlaces = placesRev.filter((x) => !placesOrig.has(x));
  if (newPlaces.length) {
    violations.push({
      ruleId: "new_places",
      evidence: `新增地点/机构样式片段：${newPlaces.slice(0, 6).join("、")}`,
    });
  }

  // 3.5) 新增机构/组织（更严格的后缀规则，避免误报）
  const orgOrig = new Set(extractOrgLike(original));
  const orgRev = unique(extractOrgLike(revised));
  const newOrgs = orgRev.filter((x) => !orgOrig.has(x));
  if (newOrgs.length) {
    violations.push({
      ruleId: "new_orgs",
      evidence: `新增机构/组织：${newOrgs.slice(0, 6).join("、")}`,
    });
  }

  // 4) 新增“研究过程/亲历”宣称
  const procOrig = new Set(extractProcessClaims(original));
  const procRev = unique(extractProcessClaims(revised));
  const newProc = procRev.filter((x) => !procOrig.has(x));
  if (newProc.length) {
    violations.push({
      ruleId: "new_research_claims",
      evidence: `新增研究过程宣称：${newProc.slice(0, 8).join("、")}`,
    });
  }

  return violations.length ? { ok: false, violations } : { ok: true };
}

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function extractNumberLike(s: string): string[] {
  // 包含：整数/小数/百分比/区间（如 10-12）
  const re = /\b\d+(?:\.\d+)?%?\b|\b\d+\s*-\s*\d+\b/g;
  return s.match(re) ?? [];
}

function extractDateLike(s: string): string[] {
  const out: string[] = [];
  // 2024年4月12日 / 2024年4月 / 2024-04-12
  const re1 = /\b\d{4}\s*年\s*\d{1,2}\s*月\s*(?:\d{1,2}\s*日)?/g;
  const re2 = /\b\d{4}-\d{1,2}-\d{1,2}\b/g;
  const re3 = /\b\d{4}\s*年\b/g;
  out.push(...(s.match(re1) ?? []));
  out.push(...(s.match(re2) ?? []));
  // 单独年份很常见：只在改写稿新增年份时才会命中
  out.push(...(s.match(re3) ?? []));
  return out;
}

function extractPlaceLike(s: string): string[] {
  /**
   * 启发式：更偏向“地理/行政/道路”后缀，避免把“校正/研究所述”等常见词误判为地点。
   *
   * 设计原因：
   * - 误报会导致大量段落被无谓拦截，用户体验表现为“怎么老是改写失败”；
   * - 地点锚点的风险主要来自省市区路街等；机构类（校/院/所）后续可单独规则更精细处理。
   */
  const re =
    /[\u4e00-\u9fff]{2,6}(?:省|市|区|县|镇|乡|街|路|大道|巷|园|港|站|桥|河|湖|山)/g;
  return s.match(re) ?? [];
}

function extractOrgLike(s: string): string[] {
  /**
   * 启发式机构/组织识别：以明确机构后缀结尾，避免把普通词（如“校正”）误当成机构。
   * 只用于“新增机构”校验：原文已有的不拦截，改写新增才拦截。
   */
  const re = /[\u4e00-\u9fff]{2,10}(?:大学|学院|研究院|研究所|公司|集团|委员会|协会|中心)/g;
  return s.match(re) ?? [];
}

function extractProcessClaims(s: string): string[] {
  // 只要出现这些词，通常就涉及“研究过程/亲历”陈述，除非原文已有
  const keywords = [
    "笔者",
    "本人",
    "我们在",
    "本文调研",
    "本研究调研",
    "实地",
    "蹲点",
    "走访",
    "访谈",
    "问卷",
    "样本",
    "抽样",
    "实验",
    "案例调研",
    "调研中发现",
    "实践经验",
    "观察发现",
  ];
  const hits: string[] = [];
  for (const k of keywords) {
    if (s.includes(k)) hits.push(k);
  }
  return hits;
}

