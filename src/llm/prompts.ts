import type { FindingSignal } from "../report/schema.js";
import type OpenAI from "openai";

export type RewriteInput = {
  paragraphText: string;
  contextBefore?: string;
  contextAfter?: string;
  signals: FindingSignal[];
  /**
   * 上一次改写被护栏拦截时的违规提示（可选）。
   *
   * 设计原因：
   * - "新增事实锚点"是最常见的拦截原因（尤其是新增地点/数字）；
   * - 与其直接失败，不如把拦截原因反馈给模型，要求"删掉这些锚点并重写"，提升可改率与整体降幅。
   */
  guardViolationsHint?: string;
};

export type RewriteOutput = {
  revisedText: string;
  changeRationale: string[];
  riskSignalsResolved: string[];
  needHumanCheck: string[];
  humanFeatures?: string[];
};

export type RewriteMode = "normal" | "aggressive" | "repair";

export type RewriteMessageOptions = {
  /**
   * 改写强度。
   *
   * 设计原因：
   * - 在"严格不增删事实"的约束下，模型可能只做轻微润色，导致"看似改写但检测分数不变"；
   * - 当我们发现改写效果不佳时，需要一次更强的结构重写来制造足够的写作差异。
   */
  mode?: RewriteMode;
  /**
   * 期望的最小表层改动比例（0-1）。
   * 注意：这是"表层表达"的改动约束，不代表改变事实或核心论点。
   */
  minChangeRatio?: number;
  /**
   * 是否启用"事实锚点占位符"模式。
   *
   * 设计原因：
   * - 对"数字/日期/引用/URL"等事实锚点做占位锁定，使模型可以更激进地做结构重写而不触碰事实；
   * - 相比事后拦截，事前锁定能显著降低失败率并提升整体降幅。
   */
  factLock?: boolean;
};

export type JudgeInput = {
  paragraphText: string;
  signals: FindingSignal[];
};

export type JudgeOutput = {
  riskScore0to100: number;
  riskLevel: "low" | "medium" | "high";
  topReasons: string[];
  shouldRewrite: boolean;
};

export function buildRewriteMessages(
  input: RewriteInput,
  opts?: RewriteMessageOptions
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const signalSummary = input.signals.map((s) => ({
    signalId: s.signalId,
    title: s.title,
    evidence: s.evidence,
    suggestion: s.suggestion,
  }));

  const mode: RewriteMode = opts?.mode ?? "normal";
  const minChangeRatio = typeof opts?.minChangeRatio === "number" ? opts.minChangeRatio : 0.25;
  const factLock = Boolean(opts?.factLock);

  /**
   * 检测段落是否主要为英文。
   * 设计原因：中英文混合论文（如含双语摘要）中，若对英文段落使用中文认知标记词，
   * LLM 会将中文直接插入英文输出，造成语言混乱。
   * 实现：统计非空白字符中 ASCII 字母占比，>55% 视为英文段落。
   */
  const isEnglish = (() => {
    const text = input.paragraphText ?? "";
    const nonSpace = text.replace(/\s/g, "");
    if (!nonSpace) return false;
    const asciiLetters = (nonSpace.match(/[A-Za-z]/g) ?? []).length;
    return asciiLetters / nonSpace.length > 0.55;
  })();

  /** 认知标记词：根据原文语言选择对应语言版本，防止英文段落中混入中文 */
  const cognitiveMarkers = isEnglish
    ? [
        "══ Cognitive Marker Words to Inject (use 1-2, reduces AI detection score) ══",
        "The following phrases signal human writing patterns to the detection system:",
        "【Surprise/Transition】Interestingly, Surprisingly, Unexpectedly, It is worth reflecting on",
        "【Researcher Perspective】In my view, I would argue that, Strictly speaking, To be candid,",
        "【Limitation Acknowledgment】Admittedly, That said, Notwithstanding, Subject to,",
        "【Contrastive Structure】However, Nevertheless, Yet, Conversely (to introduce contrast)",
        "⚠️ Use the researcher-perspective phrases for opinion only. Do NOT invent new fieldwork or interviews not present in the original.",
      ]
    : [
        "══ 必须注入的认知标记词（至少用 1-2 个，显著降低 cog_low_density 信号） ══",
        "以下词汇是我们 AIGC 检测系统判定为「人类写作痕迹」的关键标记，加入它们会直接降低检测风险分：",
        "【思维转折类】出乎意料的是、令人意外的是、有趣的是、值得反思的是、耐人寻味的是",
        "【研究者视角类】笔者认为、笔者注意到、在笔者看来、严格来说、退一步说、坦率地说",
        "【局限承认类】需要承认的是、当然也存在、尽管如此、不过这一结论、受限于、囿于",
        "【转折结构类】以「然而」「但是」「不过」「可是」开头的句子（用于增加段落内部结构切换）",
        "⚠️ 注意：「笔者认为/注意到/看来」可以使用，但严禁「笔者实地/调研/走访/访谈」（不得新增未有的研究活动）",
      ];

  return [
    {
      role: "system",
      content: [
        "你是资深学术写作修订专家，精通知网/维普/万方等 AIGC 检测系统的检测原理。",
        "你的任务是将段落改写为更像真实人类研究者的写作风格，从而降低 AIGC 检测风险，同时严格保持原意不变。",
        "",
        "══ 铁律（不可违反） ══",
        "1) 不捏造事实、引用、数据；不改变关键术语、专有名词和数值。",
        "2) 保持原文引用标记（如[1]、（作者，年份））的存在与位置。",
        "3) 改写后的文本必须与原文表达相同的学术观点，不可增删核心论点。",
        "4) 严禁新增任何【具体事实锚点】，包括但不限于：时间/日期/年份、地点（省市区路等）、样本量、问卷/访谈/实验/调研过程、机构/平台/案例名称、百分比与任何具体数字。若原文没有，就绝对不要编造。",
        "5) 改写后文本长度应与原文保持在 ±20% 以内，不要无谓扩写。",
        "6) 严禁新增【第一人称亲历宣称】：不得新增「笔者实地」「笔者调研」「笔者走访」「实地调研」「实地走访」「本人调研」等组合——除非原文已明确包含这些表达。「笔者认为/笔者指出」等意见表达允许，但「笔者+调研活动」严格禁止。",
        "7) 严禁新增具体【机构/公司名称】：若原文没有该机构，不得在改写中引入。需要泛指时只用「某公司」「相关机构」「部分平台」等非定向表达。",
        "8) 【语言一致性（绝对禁止违反）】：必须严格保持原文语言。输入为英文则全部英文输出，输入为中文则全部中文输出。严禁在改写中混入任何不同语言的词汇、短语或句子，即使系统提示中有中文示例，也绝对不得将其用于英文段落的改写输出中。",
        "",
        ...(factLock
          ? [
              "══ 事实锚点占位符（必须严格遵守） ══",
              "本次输入中可能包含形如「⟦F1⟧」「⟦F2⟧」的占位符，它们代表不可更改的事实锚点（数字/日期/引用/URL/地点/机构等专名）。",
              "1) 这些占位符必须原样保留：字符完全一致、不可增删、不可改写、不可移动位置。",
              "2) 不要在占位符内部或周边编造任何新的具体事实锚点。",
              "3) 除非原文已出现（或以占位符出现），否则禁止输出任何具体地名/机构名；需要举例时只能用泛化表达（如'部分地区''相关机构/平台'）。",
              "",
            ]
          : []),
        ...(mode === "repair"
          ? [
              "══ 护栏拦截修复（本次为修复重写） ══",
              "你上一次的输出触发了服务端真实性护栏，原因会在输入 JSON 的 guardViolationsHint 字段中给出。",
              "本次你必须：",
              "1) 删除 guardViolationsHint 中指出的【新增事实锚点片段】（不要出现同义替换版本，也不要换一种写法偷偷保留）。",
              "2) 重新改写段落，使其更像人类写作，但仍严格不新增任何新的数字/日期/地点/机构/研究过程等事实锚点。",
              "3) 若原文没有具体地点/机构，请用泛化表达替代（如'部分地区''某些平台/机构'），但不要引入任何可被定位的具体地名/机构名。",
              "",
            ]
          : []),
        ...(mode === "aggressive"
          ? [
              "══ 质量门槛（本次为强力改写） ══",
              `1) 必须产生明显表层差异：至少约 ${Math.round(minChangeRatio * 100)}% 的字词表达发生变化（允许改句式、拆并句、调序、改变论证展开方式）。`,
              "2) 必须制造极端句长差异：段落中必须包含至少 1 句不超过 12 字的短句，以及至少 1 句不少于 45 字的长句，二者相差要明显（方差要大）。",
              "3) 不允许只做同义词替换；必须通过【结构重排】降低模板感（拆并句、调序、改变论证展开方式）。",
              "4) 允许加入【边界/条件/范围/对象】的限定描述来增强可读性，但不得引入原文不存在的新事实。",
              "5) 至少做 2 种结构动作：拆句 / 并句 / 语序倒装 / 主次重排 / 论证路径重写（择二以上）。",
              "",
            ]
          : []),
        ...cognitiveMarkers,
        "",
        "══ 必须消除的 6 种 AI 特征 ══",
        "A. 模板连接词堆叠：完全删除「首先/其次/再次/最后」「此外/同时/与此同时/另外」等段落开头的模板过渡词，用因果关系和指代自然衔接。这类词出现越多扣分越高，务必清除。",
        "B. 对称结构：打破「一方面…另一方面」「不仅…而且」等工整对仗，改为侧重论述重点一方。",
        "C. 空洞总结句：彻底删除「综上所述」「具有重要意义」「不可忽视」等不含信息增量的套话段尾。",
        "D. 抽象名词堆叠：将「层面/维度/路径/机制/模式/框架」等抽象词替换为具体指代，说清楚是哪个层面、哪条路径。",
        "E. 句长均匀性（关键！）：打破每句字数相近的机械节奏。具体要求：段落里必须有明显的长短差异——最短句不超过 15 字，最长句不少于 40 字，两者之差不少于 25 字。句长差异越大越好，这是降低 AI 检测分的最重要指标之一。",
        "F. 段首套话：删除「随着…的发展」「在…背景下」「近年来」等 AI 典型段首句式，直接从核心论点开始。",
        "",
        "══ 严禁使用的特定句型（使用将导致更高 AI 检测分） ══",
        "以下句型是 AIGC 检测系统高度敏感的模式，一旦出现会显著拉高分数，绝对禁止使用：",
        "- 「值得注意的是」「值得关注的是」「需要指出的是」「需要强调的是」（这些是 AI 最常用的过渡句）",
        "- 「这一点容易被忽略」「这一现象表明」「由此可见」（模板化推论句）",
        "- 「需要进一步讨论」「有待深入研究」「具有重要的理论意义」（空洞学术套话）",
        "- 连续多句以同样的 2-3 字开头（如多句都以「这」「其」「该」开头）",
        "",
        "══ 高效降分的 3 个核心策略 ══",
        "1) 用论证代替陈述：不要说「X 是重要的」，改为用一个具体例子或对比来阐明为什么。",
        "2) 直接切入核心：从最关键的发现或结论直接开始，而不是先交代背景再说论点。",
        "3) 制造句长极差：段落中短句（<12字）和长句（>50字）的混合是人类写作的典型特征。",
        "",
        "══ 改写示例 ══",
        "",
        "【示例1 - 修复段首套话+句长均匀+模板连接词】",
        "原文：随着社交媒体的快速发展，网络舆论已经成为影响公共事件的重要力量。在此背景下，研究网络舆论的传播机制具有重要的理论意义和实践价值。",
        "改写：网络舆论如何影响公共事件？这个问题的答案并不在于「社交媒体本身」。传播链条的关键环节——信息如何被放大、如何跨圈层扩散、不同参与者在其中的实际角色——才是值得深入分析的对象，而这些在已有研究中尚未得到充分的细化处理。",
        "",
        "【示例2 - 修复首先/其次结构+综上所述+句长均匀】",
        "原文：首先，数字化转型提升了企业的运营效率。其次，数字化转型优化了企业的客户体验。此外，数字化转型还推动了商业模式创新。综上所述，数字化转型对企业发展具有深远影响。",
        "改写：运营效率的改善是数字化转型中最容易被量化的收益，流程标准化压缩了成本与时间。但真正难以预判的影响在另外两个方向：客户体验取决于多触点数据是否贯通，反馈能否被快速吸收；商业模式的变化则更难衡量——它不只是「创新」，而是一套新的价值分配逻辑，其成立需要特定条件，不能笼统而论。",
        "",
        "══ 输出格式 ══",
        "输出严格 JSON（不要输出额外解释文字）：",
        '{ "revisedText": "改写后的段落文本", "changeRationale": ["修改说明1","修改说明2"], "riskSignalsResolved": ["signalId1"], "needHumanCheck": ["需人工确认的点"], "humanFeatures": ["注入的人类特征说明"] }',
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          contextBefore: input.contextBefore ?? "",
          paragraphText: input.paragraphText,
          contextAfter: input.contextAfter ?? "",
          signals: signalSummary,
          guardViolationsHint: input.guardViolationsHint ?? "",
        },
        null,
        2,
      ),
    },
  ];
}

export function buildJudgeMessages(input: JudgeInput): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const signalSummary = input.signals.map((s) => ({
    signalId: s.signalId,
    title: s.title,
    evidence: s.evidence,
  }));

  return [
    {
      role: "system",
      content: [
        "你是严格的 AIGC 文本检测复核专家。你需要基于段落文本和已触发的规则信号，独立判断该段落是否由 AI 生成。",
        "",
        "评判标准（偏严格，宁可误报不可漏报）：",
        "- 重点关注：行文节奏是否过于均匀、用词是否缺乏个人风格、论证是否空洞套话化、结构是否过于模板化",
        "- AI 文本典型特征：对称结构多、连接词密集、抽象名词堆叠、段首套话、空洞总结、缺少具体数据和个人观察",
        "- 人类文本典型特征：句长波动大、有口语化表达或个人见解、引用具体数据/案例、有思维跳跃或修辞变化",
        "",
        "评分口径：",
        "- 90-100：几乎确定是 AI 生成，多个强信号同时存在",
        "- 70-89：高度疑似 AI 生成，建议重写",
        "- 50-69：存在明显 AI 痕迹，建议修改",
        "- 35-49：有一些 AI 特征但不确定",
        "- 0-34：更像人类写作",
        "",
        "输出严格 JSON（不要输出额外文字）：",
        '{ "riskScore0to100": 数字, "riskLevel": "low|medium|high", "topReasons": ["原因1","原因2",...], "shouldRewrite": true/false }',
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          paragraphText: input.paragraphText,
          ruleSignals: signalSummary,
        },
        null,
        2
      ),
    },
  ];
}
