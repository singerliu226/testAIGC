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
   * - “新增事实锚点”是最常见的拦截原因（尤其是新增地点/数字）；
   * - 与其直接失败，不如把拦截原因反馈给模型，要求“删掉这些锚点并重写”，提升可改率与整体降幅。
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
   * - 在“严格不增删事实”的约束下，模型可能只做轻微润色，导致“看似改写但检测分数不变”；
   * - 当我们发现改写效果不佳时，需要一次更强的结构重写来制造足够的写作差异。
   */
  mode?: RewriteMode;
  /**
   * 期望的最小表层改动比例（0-1）。
   * 注意：这是“表层表达”的改动约束，不代表改变事实或核心论点。
   */
  minChangeRatio?: number;
  /**
   * 是否启用“事实锚点占位符”模式。
   *
   * 设计原因：
   * - 对“数字/日期/引用/URL”等事实锚点做占位锁定，使模型可以更激进地做结构重写而不触碰事实；
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
        "4) 严禁新增任何“具体事实锚点”，包括但不限于：时间/日期/年份、地点（省市区路等）、样本量、问卷/访谈/实验/调研过程、机构/平台/案例名称、百分比与任何具体数字。若原文没有，就绝对不要编造。",
        "",
        ...(factLock
          ? [
              "══ 事实锚点占位符（必须严格遵守） ══",
              "本次输入中可能包含形如「⟦F1⟧」「⟦F2⟧」的占位符，它们代表不可更改的事实锚点（数字/日期/引用/URL/地点/机构等专名）。",
              "1) 这些占位符必须原样保留：字符完全一致、不可增删、不可改写、不可移动位置。",
              "2) 不要在占位符内部或周边编造任何新的具体事实锚点。",
              "3) 除非原文已出现（或以占位符出现），否则禁止输出任何具体地名/机构名；需要举例时只能用泛化表达（如“部分地区”“相关机构/平台”）。",
              "",
            ]
          : []),
        ...(mode === "repair"
          ? [
              "══ 护栏拦截修复（本次为修复重写） ══",
              "你上一次的输出触发了服务端真实性护栏，原因会在输入 JSON 的 guardViolationsHint 字段中给出。",
              "本次你必须：",
              "1) 删除 guardViolationsHint 中指出的“新增事实锚点片段”（不要出现同义替换版本，也不要换一种写法偷偷保留）。",
              "2) 重新改写段落，使其更像人类写作，但仍严格不新增任何新的数字/日期/地点/机构/研究过程等事实锚点。",
              "3) 若原文没有具体地点/机构，请用泛化表达替代（如“部分地区”“某些平台/机构”），但不要引入任何可被定位的具体地名/机构名。",
              "",
            ]
          : []),
        ...(mode === "aggressive"
          ? [
              "══ 质量门槛（本次为强力改写） ══",
              `1) 必须产生明显表层差异：至少约 ${Math.round(
                minChangeRatio * 100
              )}% 的字词表达发生变化（允许改句式、拆并句、调序、改变论证展开方式）。`,
              "2) 必须重排句子节奏：至少出现 1 句短句（<15字）与 1 句长句（>40字）。",
              "3) 不允许只做同义词替换；必须通过“结构重排”降低模板感（拆并句、调序、改变论证展开方式）。",
              "4) 允许加入“边界/条件/范围/对象”的限定描述来增强可读性，但不得引入原文不存在的新事实。",
              "5) 至少做 2 种结构动作：拆句 / 并句 / 语序倒装 / 主次重排 / 论证路径重写（择二以上）。",
              "",
            ]
          : []),
        "══ 必须消除的 6 种 AI 特征 ══",
        "A. 模板连接词堆叠：删除或替换「首先/其次/再次/最后」「此外/同时/与此同时」等模板化过渡词，改为用因果关系和指代自然衔接。",
        "B. 对称结构：打破「一方面…另一方面」「不仅…而且」等工整对仗，改为侧重论述重点一方。",
        "C. 空洞总结句：删除段尾的「综上所述」「具有重要意义」等不含信息增量的套话。",
        "D. 抽象名词堆叠：将「层面/维度/路径/机制/模式/框架」等抽象词替换为具体指代（是什么层面？哪条路径？）。",
        "E. 句长均匀性：打破每句字数接近的机械节奏，混合使用短句（<15字）和长句（>40字）。",
        "F. 段首套话：删除「随着…的发展」「在…背景下」「近年来」等 AI 典型段首句式，直接从核心论点开始。",
        "",
        "══ 必须注入的 4 种人类写作特征 ══",
        "G. 认知摩擦：在适当位置加入思维转折（如「但值得注意的是」「这一点容易被忽略」），体现推理过程，但不要虚构“亲历调研/访谈/实验”。",
        "H. 边界限定：用范围/条件/对象的限定语替代笼统描述（如「在本文讨论的X范围内」替代「总体而言」），不得新增原文没有的时间/地点/数字。",
        "I. 句长波动：刻意制造句长差异，在连续长句后插入一个短句做总结或转折，在短句后跟一个展开论述的长句。",
        "J. 研究者视角：可加入对论证边界与局限的评述（如「需要进一步讨论其适用条件」），不得声称“笔者调研发现/实践经验”除非原文已明确写出。",
        "",
        "══ 改写示例 ══",
        "",
        "【示例1】",
        "原文：随着社交媒体的快速发展，网络舆论已经成为影响公共事件的重要力量。在此背景下，研究网络舆论的传播机制具有重要的理论意义和实践价值。",
        "改写：网络舆论对公共事件的影响力不容忽视。要解释这种影响力如何产生，需要把讨论落到传播链条的关键环节：信息如何被放大、如何跨圈层扩散、以及不同参与者在其中扮演的角色，而不是停留在「社交媒体发展」的笼统归因上。",
        "",
        "【示例2】",
        "原文：首先，数字化转型提升了企业的运营效率。其次，数字化转型优化了企业的客户体验。此外，数字化转型还推动了商业模式创新。综上所述，数字化转型对企业发展具有深远影响。",
        "改写：数字化转型带来的变化很难用一句话概括。运营效率的改善往往更直观，因为流程被标准化后，成本与时间消耗更容易被压缩。客户体验的提升则取决于多个触点是否能形成协同：数据能否贯通、服务能否连续、反馈能否被及时吸收。至于商业模式创新，它往往是最难衡量的一类结果，需要明确讨论其发生条件与适用范围，而非用套话作结。",
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

