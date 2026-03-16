export type RewriteGuardResult =
  | { ok: true }
  | { ok: false; violations: Array<{ ruleId: string; evidence: string }> };

export type RewriteGuardParams = {
  originalText: string;
  revisedText: string;
};

/**
 * 改写真实性护栏：阻止模型"为了更像人类"而编造事实锚点。
 *
 * 设计原因：
 * - 用户目标是降低 AI 检测风险，但论文场景里"新增具体时间/地点/样本/调研经历"等属于高风险伪造；
 * - 仅靠 prompt 约束不可靠：必须在服务端做可解释的校验与拦截。
 *
 * 实现方式：
 * - 对比原文与改写稿，检测改写稿中出现而原文未出现的"事实锚点"：
 *   - 数字/百分比/区间（阿拉伯数字）
 *   - 日期样式（YYYY年MM月DD日、YYYY-MM-DD 等）
 *   - 类地名片段（以 省/市/区/县/路/街/大道 等结尾的中文短语，泛化词除外）
 *   - 研究过程宣称（问卷/访谈/实地/调研/笔者/本文调研 等）
 *
 * 注意：这是启发式规则，宁可偏严，避免"看似降分但内容失真"。
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

  // 4) 新增"研究过程/亲历"宣称
  const procOrig = new Set(extractProcessClaims(original));
  const procRev = unique(extractProcessClaims(revised));
  const newProc = procRev.filter((x) => !procOrig.has(x));
  if (newProc.length) {
    violations.push({
      ruleId: "new_research_claims",
      evidence: `新增研究过程宣称：${newProc.slice(0, 8).join("、")}`,
    });
  }

  // 5) 英文亲历宣称（英文论文专项）
  // 设计原因：中文护栏的关键词（笔者/调研等）不能覆盖英文，需要专门检查英文 fieldwork 声明
  const enProcOrig = new Set(extractEnglishProcessClaims(original));
  const enProcRev = unique(extractEnglishProcessClaims(revised));
  const newEnProc = enProcRev.filter((x) => !enProcOrig.has(x));
  if (newEnProc.length) {
    violations.push({
      ruleId: "new_en_research_claims",
      evidence: `New first-person fieldwork claims added: ${newEnProc.slice(0, 5).join("; ")}`,
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

/**
 * 泛化地理描述词白名单：这些词以地理后缀结尾，但不指向具体地点，应排除在"新增地名"检测之外。
 *
 * 设计原因：
 * - sanitizeNewAnchors 会把具体地名替换为这类泛化词；
 * - 若不排除，会造成"替换后仍被误报 → 再次拦截"的死循环；
 * - 泛化词本身不属于需要保护的"事实锚点"，因此安全地豁免。
 */
const GENERIC_GEO_WHITELIST = new Set([
  "部分地区",
  "相关地区",
  "该地区",
  "各地区",
  "本地区",
  "其他地区",
  "全国各地",
  "某地区",
  "部分地市",
  "各地市",
  "当地",
  "各地",
  "某地",
  "多地",
  "全国",
  "境内",
  "国内",
  "涉部分地区",
]);

function extractPlaceLike(s: string): string[] {
  /**
   * 启发式：更偏向"地理/行政/道路"后缀，避免把"校正/研究所述"等常见词误判为地点。
   *
   * 设计原因：
   * - 误报会导致大量段落被无谓拦截，用户体验表现为"怎么老是改写失败"；
   * - 地点锚点的风险主要来自省市区路街等；机构类（校/院/所）后续可单独规则更精细处理。
   * - 泛化表达（"部分地区""相关地区"等）排除在外，避免 sanitize 替换后仍被误报。
   */
  const re =
    /[\u4e00-\u9fff]{2,6}(?:省|市|区|县|镇|乡|街|路|大道|巷|园|港|站|桥|河|湖|山)/g;
  return (s.match(re) ?? []).filter((m) => !GENERIC_GEO_WHITELIST.has(m));
}

/**
 * 泛化机构/组织描述词白名单：以机构后缀结尾但不指向具体机构，应排除在"新增机构"检测之外。
 *
 * 设计原因：
 * - sanitizeNewAnchors 会把具体机构名替换为"某公司""相关机构"等泛化词；
 * - 若不排除，会造成替换后仍被误报的死循环；
 * - 泛化词本身不属于需要保护的"事实锚点"，因此安全地豁免。
 */
const GENERIC_ORG_WHITELIST = new Set([
  "某公司",
  "某地公司",
  "部分公司",
  "某机构",
  "某地机构",
  "某平台",
  "某地平台",
  "某学院",
  "某大学",
  "某研究院",
  "某研究所",
  "某中心",
  "某协会",
  "某集团",
  "相关公司",
  "相关机构",
  "相关平台",
  "相关单位",
  "相关部门",
  "部分公司",
  "部分机构",
  "部分平台",
  "各大公司",
  "各大机构",
  "各大平台",
  "各大学",
  "各学院",
  "该公司",
  "该机构",
  "该平台",
  "该大学",
  "该学院",
  "该研究院",
  "该中心",
  "互联网公司",
  "媒体机构",
  "新闻机构",
  "科研机构",
  "学术机构",
  "政府机构",
  "监管机构",
]);

function extractOrgLike(s: string): string[] {
  /**
   * 启发式机构/组织识别：以明确机构后缀结尾，避免把普通词（如"校正"）误当成机构。
   * 只用于"新增机构"校验：原文已有的不拦截，改写新增才拦截。
   * 泛化词（"某公司""相关机构"等）排除在外，避免 sanitize 替换后仍被误报。
   */
  const re = /[\u4e00-\u9fff]{2,10}(?:大学|学院|研究院|研究所|公司|集团|委员会|协会|中心)/g;
  return (s.match(re) ?? []).filter((m) => !GENERIC_ORG_WHITELIST.has(m));
}

/**
 * 英文论文亲历调研声明检测。
 *
 * 设计原因：
 * - 英文论文改写时模型可能添加 "I conducted a survey" / "I interviewed" 等第一人称亲历声明；
 * - 中文护栏无法覆盖英文，需要专项检测；
 * - 只检测"具体调研行为"的组合，不拦截合法的 "I argue" / "I suggest" 等学术意见表达。
 */
function extractEnglishProcessClaims(s: string): string[] {
  const hits: string[] = [];

  // 第一人称 + 调研/观察动作 组合（精确匹配避免误报）
  const patterns = [
    /\bI\s+conducted\s+(?:a\s+)?(?:survey|interview|questionnaire|experiment|field\s*work|study|research)\b/gi,
    /\bI\s+(?:interviewed|surveyed|observed|collected\s+data|distributed\s+questionnaires?)\b/gi,
    /\bwe\s+conducted\s+(?:a\s+)?(?:survey|interview|field\s*work|experiment)\b/gi,
    /\bfield(?:\s*work|\s*research|\s*study)\s+(?:was\s+)?conducted\s+by\s+(?:me|us|the\s+author)\b/gi,
    /\bI\s+visited\b(?:.{0,30})\b(?:school|university|company|factory|site)\b/gi,
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m) hits.push(...m.map((v) => v.trim().slice(0, 60)));
  }

  return hits;
}

function extractProcessClaims(s: string): string[] {
  /**
   * 研究过程/亲历宣称检测：只拦截真正"声称亲历调研"的表达，允许普通学术主语。
   *
   * 设计原因：
   * - "笔者认为/笔者指出" 是正常学术表达，不应拦截；
   * - "笔者实地/笔者调研/笔者访谈" 才是伪造第一手经历，必须拦截；
   * - "实地调研/实地走访" 等独立短语同样属于亲历宣称，应拦截；
   * - 过度拦截会导致大量正常改写失败，用户体验差，因此收紧精度。
   */
  const hits: string[] = [];

  // 严格亲历宣称：这些短语独立出现即代表伪造（不含笔者时也算）
  const strictClaims = [
    "实地调研",
    "实地走访",
    "实地采访",
    "实地观察",
    "蹲点",
    "走访调研",
    "问卷调查",
    "问卷数据",
    "案例调研",
    "调研中发现",
    "调研数据显示",
    "实践经验",
    "本文调研",
    "本研究调研",
    "本人调研",
    "我们在",
    "我们调研",
  ];
  for (const k of strictClaims) {
    if (s.includes(k)) hits.push(k);
  }

  // 宽松亲历宣称："笔者/本人" 只有与研究活动词语组合才拦截
  const activityVerbs = ["实地", "调研", "访谈", "走访", "蹲点", "问卷", "抽样", "观察发现", "调查发现"];
  if (s.includes("笔者") || s.includes("本人")) {
    for (const v of activityVerbs) {
      if (s.includes(v)) {
        hits.push("笔者");
        break;
      }
    }
  }

  return hits;
}
