# 知网对齐样本补充说明

## 目的
这份文档用于固定说明：
- 当前哪些真实知网样本已经入库
- 后续还需要补什么样本
- 每份样本的 JSON 应该怎么写

当前代码会自动扫描 `data/cnki-calibration/` 目录下的所有 `.json` 文件，并汇总评估结果。

## 当前已入库样本

### 1. `real/english-baseline-fubenchugao5.json`
- 文档：`客户文件/副本初稿5.docx`
- 语言：英文
- 本地原始分：`14`
- 当前知网代理分：`14`
- 用户提供的真实知网分：`31.4`
- 用途：验证“本地分数与真实知网总分的偏差基线”
- 限制：该样本没有知网高风险段标注，而且是英文论文，**不能直接用于中文规则调参**

## 当前校准状态

截至目前，系统里只有 `1` 个真实知网样本，而且是英文样本。

这意味着：
- 当前系统已经具备“真实样本入库 -> 自动评估 -> 持续校准”的能力
- 但**还不能仅凭这一份样本就宣称“知网预测已经足够准”**
- 目前这份样本更适合回答：“当前系统和真实知网大概差多少”，还不适合用来做大范围权重回归

当前这份真实样本反映出的基线现象是：
- 英文样本 `副本初稿5.docx`
- 本地 `predictedCnkiScore = 14`
- 真实知网 `actualCnkiScore = 31.4`
- 当前英文总分误差约 `17.4` 个点

如果你希望把中文结果真正往知网靠，下一批样本请优先补中文论文。

## 后续优先补什么真实样本

### 最低可用样本
只要你能提供以下 4 项，就可以先入库并参与“总分误差”评估：
- 原始文档路径或文件名
- 本地检测结果中的 `overallRiskScore`
- 本地检测结果中的 `overallCnkiPredictedScore`
- 真实知网总分

### 推荐样本
如果还能补下面这些，效果会明显更好：
- 文档语言：`zh` 或 `en`
- 文档类型：如 `undergraduate-thesis`、`journal-paper`、`course-paper`
- 真实知网高风险段对应的本地段落编号
- 知网结果截图、PDF 或人工记录说明

### 最理想样本
如果你希望后面把“高风险段定位”也一起调准，最好额外提供：
- 知网标红页或段落截图
- 每个高风险段能对应到本地的 `paragraphId` 或段落序号
- 文档是否含摘要、文献综述、研究意义、研究方法、结论/展望等论文模板段

## 建议你后面给我的真实样本包

每篇论文建议至少给我下面这些材料：

1. 原文文件
- `.docx` 优先
- 如果只有 `.pdf` 或截图，也可以先提供，但会降低段落定位精度

2. 本地检测结果
- 直接给会话 ID，或者把页面上的：
  - `overallRiskScore`
  - `overallCnkiPredictedScore`
  - 高风险段列表
  发给我

3. 真实知网结果
- 至少给总分
- 最好附截图或 PDF
- 如果知网有明显标红段，请一并发我

4. 背景说明
- 论文语言：中文 / 英文
- 论文类型：本科 / 硕士 / 课程论文 / 期刊稿
- 是否为“文献综述重、方法论重、结论总结重”的论文

## JSON 格式说明

可以直接复制：
- `docs/cnki-calibration-template.sample.json`

### 最低可用格式

```json
{
  "documentId": "sample-20260320-001",
  "title": "某篇论文.docx",
  "language": "zh",
  "documentType": "undergraduate-thesis",
  "sourceFile": "客户文件/某篇论文.docx",
  "rawLocalScore": 26,
  "predictedCnkiScore": 34,
  "actualCnkiScore": 38.7,
  "predictedHighRiskParagraphIds": [],
  "roleTagsHit": [],
  "evidence": {
    "actualScoreSource": "知网截图/报告"
  },
  "notes": "只有总分，没有段落标注。"
}
```

### 完整推荐格式

```json
{
  "documentId": "sample-20260320-002",
  "title": "某篇中文论文.docx",
  "language": "zh",
  "documentType": "undergraduate-thesis",
  "sourceFile": "客户文件/某篇中文论文.docx",
  "rawLocalScore": 29,
  "predictedCnkiScore": 36,
  "actualCnkiScore": 41.2,
  "predictedHighRiskParagraphIds": ["p-14", "p-28", "p-63"],
  "actualHighRiskParagraphIds": ["p-14", "p-31", "p-63"],
  "roleTagsHit": ["literatureReview", "researchSignificance", "researchMethod"],
  "evidence": {
    "actualScoreSource": "知网报告 PDF 第 1 页",
    "actualParagraphSource": "知网标红截图 + 人工映射"
  },
  "notes": "第 31 段在知网标红，但本地当前没有命中，需要继续调段落角色与方法模板权重。"
}
```

## 字段解释
- `documentId`：唯一 ID，建议带日期
- `title`：文档标题或文件名
- `language`：`zh` / `en`
- `documentType`：论文类型，方便后续分组统计
- `sourceFile`：原文路径
- `rawLocalScore`：本地通用风险分
- `predictedCnkiScore`：本地知网代理分
- `actualCnkiScore`：真实知网总分
- `predictedHighRiskParagraphIds`：当前系统判高的段落
- `actualHighRiskParagraphIds`：真实知网高风险段的映射结果；如果没有，允许不填
- `roleTagsHit`：本地识别到的关键角色标签
- `evidence.actualScoreSource`：真实知网分数的来源说明
- `evidence.actualParagraphSource`：高风险段标注来源说明
- `notes`：补充备注

## 评估命令

在 `aigc-docx-agent` 目录执行：

```bash
node --import tsx src/scripts/evaluateCnkiAlignment.ts
```

如果你只想评估某一个文件或某个子目录：

```bash
node --import tsx src/scripts/evaluateCnkiAlignment.ts data/cnki-calibration/real
```

## 结果怎么看
- `scoreMae / scoreRmse`：看总分和真实知网差多少
- `highRiskParagraph.precision / recall / f1`：看高风险段定位准不准
- `highRiskParagraph.coverage`：看当前有多少样本已经补了真实高风险段标注
- `byLanguage`：看中文、英文分别偏差多大

## 现阶段建议
- 中文规则升级已经完成，但**要真正把中文结果继续往知网靠**，后面最有价值的是补 **中文论文** 的真实知网样本。
- 优先补这三类中文论文：
  - 文献综述很重的论文
  - 研究意义 / 研究方法 / 章节安排很明显的论文
  - 结论与展望模板感很强的论文
