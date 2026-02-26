import type { FindingSignal } from "../report/schema.js";
import type OpenAI from "openai";

export type RewriteInput = {
  paragraphText: string;
  contextBefore?: string;
  contextAfter?: string;
  signals: FindingSignal[];
};

export type RewriteOutput = {
  revisedText: string;
  changeRationale: string[];
  riskSignalsResolved: string[];
  needHumanCheck: string[];
  humanFeatures?: string[];
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

export function buildRewriteMessages(input: RewriteInput): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const signalSummary = input.signals.map((s) => ({
    signalId: s.signalId,
    title: s.title,
    evidence: s.evidence,
    suggestion: s.suggestion,
  }));

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
        "",
        "══ 必须消除的 6 种 AI 特征 ══",
        "A. 模板连接词堆叠：删除或替换「首先/其次/再次/最后」「此外/同时/与此同时」等模板化过渡词，改为用因果关系和指代自然衔接。",
        "B. 对称结构：打破「一方面…另一方面」「不仅…而且」等工整对仗，改为侧重论述重点一方。",
        "C. 空洞总结句：删除段尾的「综上所述」「具有重要意义」等不含信息增量的套话。",
        "D. 抽象名词堆叠：将「层面/维度/路径/机制/模式/框架」等抽象词替换为具体指代（是什么层面？哪条路径？）。",
        "E. 句长均匀性：打破每句字数接近的机械节奏，混合使用短句（<15字）和长句（>40字）。",
        "F. 段首套话：删除「随着…的发展」「在…背景下」「近年来」等 AI 典型段首句式，直接从核心论点开始。",
        "",
        "══ 必须注入的 4 种人类写作特征 ══",
        "G. 认知摩擦：在适当位置插入思维转折（「但值得注意的是」「这一发现与预期有所不同」「笔者在调研中发现」），体现研究者的真实思考过程。",
        "H. 具体锚点：用具体的时间、地点、数据范围、研究对象替代笼统描述（如「某省3个城市的287份问卷」替代「大量调查数据」）。",
        "I. 句长波动：刻意制造句长差异，在连续长句后插入一个短句做总结或转折，在短句后跟一个展开论述的长句。",
        "J. 个人化评述：在关键结论后加入研究者视角的评论（「这一趋势在笔者所调研的案例中尤为突出」「从实践经验来看」），但不可捏造数据。",
        "",
        "══ 改写示例 ══",
        "",
        "【示例1】",
        "原文：随着社交媒体的快速发展，网络舆论已经成为影响公共事件的重要力量。在此背景下，研究网络舆论的传播机制具有重要的理论意义和实践价值。",
        "改写：网络舆论对公共事件的影响力在近五年持续攀升——2020年至2024年间，微博热搜引发线下行动的案例数量增长了近三倍。要理解这种影响力从何而来，就需要拆解舆论从发酵到扩散的具体路径，而非简单归因于「社交媒体的发展」。",
        "",
        "【示例2】",
        "原文：首先，数字化转型提升了企业的运营效率。其次，数字化转型优化了企业的客户体验。此外，数字化转型还推动了商业模式创新。综上所述，数字化转型对企业发展具有深远影响。",
        "改写：数字化转型对企业的影响并非均质化的。运营效率层面的收益最为直接，ERP和自动化工具的部署通常在6-12个月内即可见效。客户体验的优化则更为复杂，它依赖于数据中台的成熟度和前端触点的协同能力。相比之下，商业模式创新是最难衡量却可能回报最高的维度——笔者在调研中发现，真正实现模式转型的企业占比不足15%。",
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

