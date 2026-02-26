export type RiskLevel = "low" | "medium" | "high";

export type CategoryId =
  | "languageStats"
  | "styleHabits"
  | "logicCoherence"
  | "verifiability"
  | "structureFormat"
  | "aiPattern"
  | "cognitiveFeatures";

export type FindingSignal = {
  signalId: string;
  category: CategoryId;
  /**
   * 信号标题（面向用户）。
   * - 不做“模型术语堆砌”，而是告诉用户“哪里不自然/为什么像AIGC”。
   */
  title: string;
  /**
   * 证据（高亮片段或触发条件描述）。
   * - 让用户能“看见”触发点，而不是只给一个概率。
   */
  evidence: string[];
  /**
   * 建议（可执行）。
   * - 会被后续改写器用作约束与目标。
   * - 也能让用户手动修改时有明确方向。
   */
  suggestion: string;
  /**
   * 该信号贡献的分值（用于可解释性与调参）。
   */
  score: number;
};

export type ParagraphReport = {
  paragraphId: string;
  index: number;
  kind: "paragraph" | "tableCellParagraph";
  /** 原段落文本（可用于 UI 展示；如担心隐私可在服务端做截断） */
  text: string;
  riskScore: number; // 0..100
  riskLevel: RiskLevel;
  signals: FindingSignal[];
};

export type DocumentReport = {
  generatedAt: number;
  overallRiskScore: number;
  overallRiskLevel: RiskLevel;
  paragraphReports: ParagraphReport[];
  /**
   * 固定输出的局限说明，避免用户将“检测分数”当作定性证据。
   */
  limitations: string[];
};

