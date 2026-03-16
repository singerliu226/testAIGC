# aigc-docx-agent 项目总览

面向毕业论文/论文的「上传 → AI 检测 → 改写降重 → 导出」一站式工具。用户上传 .docx，系统做规则+LLM 检测、段落级改写（含一键自动降重）、积分计费与兑换码充值，管理员可管理兑换码与查看活跃看板。

---

## 一、技术栈与目录结构

| 层级 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js ≥20 | ESM 模块 |
| 后端 | Express 5、TypeScript | 单进程，无数据库 |
| 解析/导出 | JSZip、正则 + 栈扫描 | docx = zip + OOXML，局部替换保排版 |
| 检测 | nodejieba、自定义特征 | 规则 + 可选 LLM 复核 |
| LLM | 阿里云 Dashscope（OpenAI 兼容） | 改写、Judge、聊天改写 |
| 前端 | 单页 HTML + 内联 JS | 无框架，`web/index.html` |
| 存储 | 文件系统（可选内存） | `data/`：账本、兑换码、审计、sessions |

```
aigc-docx-agent/
├── src/
│   ├── index.ts                 # 入口：logger + createApp + listen
│   ├── server/
│   │   ├── app.ts               # Express 装配、安全头、静态、admin 路径混淡
│   │   ├── sessionStore.ts      # SessionRecord 类型、InMemorySessionStore
│   │   ├── sessionStoreDisk.ts  # DiskSessionStore、listAllForAdmin
│   │   ├── routes/
│   │   │   ├── api.ts           # 统一 API 路由注册（upload/session/rewrite/export/chat/admin）
│   │   │   ├── asyncHandler.ts
│   │   │   └── api/
│   │   │       ├── uploadRoutes.ts   # POST /upload：解析+检测，LLM 复核后台异步
│   │   │       ├── sessionRoutes.ts  # GET /sessions, /session/:id, /report/:id
│   │   │       ├── rewriteRoutes.ts  # 单段改写、复检、一键降重(同步)、自动降重(后台任务)
│   │   │       ├── exportRoutes.ts   # GET /export/:sessionId 下载 docx
│   │   │       ├── chatRoutes.ts     # 聊天式改写
│   │   │       ├── baseRoutes.ts     # health, config, balance, redeem
│   │   │       └── adminRoutes.ts    # verify, accounts, topup, 兑换码, activity
│   │   ├── autoRewrite/
│   │   │   ├── jobRunner.ts      # runAutoRewriteJob：轮次+批处理，写回 autoRewriteJob
│   │   │   └── rewriteOneInternal.ts
│   │   ├── rateLimit.ts
│   │   ├── errors.ts
│   │   └── requestContext.ts
│   ├── docx/
│   │   ├── parser.ts             # parseDocx：JSZip + splitDocumentXmlIntoParts
│   │   ├── documentXml.ts        # shieldTagBlocks（栈扫描）、shieldNestedBlocks、splitDocumentXmlIntoParts
│   │   ├── patcher.ts           # patchDocxParagraphs：按段落替换文本，跳过 imageParagraph
│   │   └── xmlText.ts
│   ├── analysis/
│   │   ├── detector.ts          # detectAigcRisk：特征+信号+段落/文档评分
│   │   ├── features.ts
│   │   ├── textUtils.ts         # tokenizeZh（nodejieba）等
│   │   └── lexicons.ts
│   ├── llm/
│   │   ├── client.ts            # createDashscopeClient、chatJson
│   │   ├── prompts.ts           # buildRewriteMessages、语言一致性等
│   │   ├── rewriter.ts          # rewriteParagraphWithDashscope、lockFacts/restoreFacts
│   │   ├── rewriteGuard.ts      # validateRewriteGuard（禁止新增事实锚点）
│   │   ├── factLocker.ts        # lockFacts/restoreFacts/validatePlaceholders
│   │   ├── judge.ts             # judgeParagraphWithDashscope（上传后后台复核）
│   │   └── chatRewriter.ts      # 聊天式改写
│   ├── billing/
│   │   ├── index.ts             # ledger、redeemStore、getAccountId、isAdmin、verifyAdminSecret
│   │   ├── fileLedger.ts        # 积分账本
│   │   ├── pricing.ts           # 计费配置、estimatePrechargePoints、calcFinalChargePoints
│   │   ├── redeemCode.ts        # 兑换码生成与核销
│   │   └── ...
│   ├── report/
│   │   └── schema.ts            # DocumentReport、ParagraphReport、FindingSignal、RiskLevel
│   └── logger/
├── web/
│   ├── index.html               # 用户端单页：上传、报告、改写、导出、历史、兑换、预检/难度面板
│   └── admin.html               # 管理员：登录、兑换码、账号、活跃看板
├── data/                        # 运行时生成（或 DATA_DIR）
│   ├── ledger.json
│   ├── redeem-codes.json
│   ├── admin-audit.log
│   └── sessions/<sessionId>/
│       ├── state.json
│       ├── original.docx
│       └── revised.docx（可选）
├── zeabur.json                  # 构建/启动命令、持久化卷 /app/data
├── package.json
└── tsconfig.json
```

---

## 二、核心数据流

### 1. 上传与检测

```
用户选择 .docx
  → POST /api/upload（FormData，带 x-account-id）
  → multer 内存 buffer
  → parseDocx(buffer)：JSZip 解压，documentXml → splitDocumentXmlIntoParts（先 shield 再正则 <w:p>）
  → detectAigcRisk(paragraphs)：规则+特征+信号 → reportBefore
  → store.create + store.update（paragraphs, reportBefore）
  → res.json({ sessionId, report, judgeStatus: "pending" })
  → 后台 IIFE：对 riskScore≥50 的段落做 judgeParagraphWithDashscope，融合分数后 store.update(reportBefore)
```

- **多图性能**：`documentXml.ts` 用 `shieldTagBlocks`（栈扫描 O(n)）按顺序屏蔽 `w:drawing`、`mc:AlternateContent`、`v:shape`、`v:pict` 等，避免正则灾难性回溯；前端按文件大小显示“约需 10–30 秒”等提示。

### 2. 改写与导出

- **单段/多段改写**：`POST /api/rewrite/:sessionId`，body `{ paragraphIds }`。预扣积分 → `rewriteOne`（normal/aggressive 二选一、guard、相似度/风险分）→ 按 usage 结算 → 写回 `revised`、`rewriteResults`、`reportAfter`。
- **一键自动降重（后台任务）**：`POST /api/rewrite-to-target/:sessionId/start` 创建 `autoRewriteJob`，`runAutoRewriteJob` 轮次执行、跳过 `imageParagraph`、尊重 `paragraphRewriteCounts` 上限；前端轮询 `GET /api/rewrite-to-target/:sessionId/status/:jobId`。
- **导出**：`GET /api/export/:sessionId` 根据 `revised` 调用 `patchDocxParagraphs`（跳过 imageParagraph），生成 revised.docx 或原稿，`Content-Disposition` 下载。

### 3. 会话与权限

- **会话归属**：所有会话带 `accountId`（来自 `x-account-id`）；`list`/`get` 均按 accountId 过滤，防止越权。
- **上次会话恢复**：前端 `localStorage` 存 `aigc_last_session_id`，上传成功或历史恢复时写入；`init()` 末尾用 `lastSessionKey` 拉取 session，若有 `autoRewriteJob` 则 `resumeJobPolling`。
- **下载体验**：`syncExportButtons` 同时设置 `previewDownload.href`；`openPreview()` 无 session 时 toast「请先上传或从历史恢复」。

### 4. 计费与兑换

- **积分**：`FileLedger` 落盘在 `data/`；`ensureAccount(accountId, defaultFreePoints)`；改写/聊天按 `pricing` 预扣+usage 结算。
- **兑换码**：`RedeemCodeStore`，`POST /api/billing/redeem` 核销后 `ledger.topup`。
- **管理员**：`x-admin-secret` 与 `ADMIN_SECRET` 一致即管理员；`ADMIN_PATH_TOKEN` 存在时仅 `/admin-<token>.html` 可访问管理页。

### 5. 管理员与活跃看板

- `POST /api/admin/verify` 校验密钥；`GET /api/admin/activity` 返回当前活跃任务、内存、上传统计等，依赖 `store.listAllForAdmin()`。

---

## 三、关键类型（便于改动的锚点）

| 类型 | 所在文件 | 用途 |
|------|----------|------|
| `SessionRecord` | sessionStore.ts | 会话全量：paragraphs、reportBefore/After、revised、rewriteResults、revision、revisedDocx、paragraphRewriteCounts、autoRewriteJob、chatMessages |
| `SessionSummary` | sessionStore.ts | listAllForAdmin 的项（含 accountId、autoRewriteJob） |
| `DocumentReport` / `ParagraphReport` / `FindingSignal` | report/schema.ts | 检测输出与信号结构 |
| `DocxParagraph`（id, index, kind, text, xml） | documentXml.ts | kind：paragraph / tableCellParagraph / imageParagraph |
| `RewriteOutput` | llm/prompts.ts | revisedText、changeRationale、riskSignalsResolved、needHumanCheck、humanFeatures |

---

## 四、环境变量（常用）

| 变量 | 说明 |
|------|------|
| `PORT` | 服务端口，默认 8787 |
| `NODE_ENV` | development / production |
| `DATA_DIR` | 数据目录，默认 `./data`；Zeabur 上多为 `/app/data` |
| `SESSION_STORE` | `memory` \| `disk`，默认 disk |
| `MAX_UPLOAD_MB` | 上传体积上限，默认 20 |
| `DASHSCOPE_API_KEY` | 阿里云 Dashscope API Key，无则无 LLM 复核/改写 |
| `ADMIN_SECRET` | 管理员密码，无则无法登录管理页 |
| `ADMIN_PATH_TOKEN` | 设置后仅 `/admin-<token>.html` 可访问管理页 |
| `DEFAULT_FREE_POINTS` | 新账号默认赠送积分 |
| `CONTACT_WECHAT` | 前端展示的联系方式等 |

---

## 五、前端 index.html 要点

- **状态**：`state = { sessionId, session, selected, chatParagraphId, chatSending }`；`accountId`、`lastSessionKey`、`adminSecret` 存 localStorage。
- **主要函数**：`fetchSession`、`syncExportButtons`、`openPreview`、`render`、`renderDifficultyPanel`、`calcPaperAssessment`、`calcAutoRewritePreview`、`openRewriteConfirm`、`resumeJobPolling`、`init`（拉 config/balance、可选恢复 lastSession 与 job 轮询）。
- **上传**：进度条假进度 + 按文件大小提示；成功后写 `lastSessionKey`，若有 judge 则轮询 session 直到分数更新。
- **自动降重**：调用 start → 轮询 status → 展示 progress（processed/maxTotal、overallCurrent）；失败用 `rwFailModal`，可“继续带风险”。

---

## 六、近期已做修改（上下文）

1. **Session 恢复与下载**：持久化 `lastSessionKey`；init 时恢复上次 session 并恢复 job 轮询；`syncExportButtons` 同步 `previewDownload.href`；无 session 时 `openPreview` 弹出 toast。
2. **多图上传卡顿**：`documentXml.ts` 用栈扫描 `shieldTagBlocks` 替代原先对 `mc:AlternateContent` 等的正则，并增加 `v:shape`/`v:pict` 屏蔽；上传提示按文件大小分段（如 1–5MB、5–15MB）。
3. **自动降重**：后台任务 + `paragraphRewriteCounts` 限制单段重写次数；预检难度面板、改写失败弹窗与“继续带风险”流程。

---

## 七、常见改动入口

| 需求 | 建议修改位置 |
|------|--------------|
| 调整检测规则/分数 | `src/analysis/detector.ts`、`features.ts`、`lexicons.ts` |
| 调整改写提示词或强度 | `src/llm/prompts.ts`、`rewriter.ts`、`rewriteGuard.ts` |
| 计费/兑换码逻辑 | `src/billing/pricing.ts`、`redeemCode.ts`、`fileLedger.ts` |
| 上传/导出/会话 API | `src/server/routes/api/` 对应路由 |
| 自动降重轮次/批大小/上限 | `rewriteRoutes.ts`（start 的 body 默认）、`jobRunner.ts`（BATCH_SIZE、MAX_CUMULATIVE_REWRITES） |
| 前端文案、弹窗、难度面板 | `web/index.html` 内对应 DOM 与函数 |
| 管理端功能 | `web/admin.html`、`adminRoutes.ts` |

以上为当前项目全貌与上下文，可直接在此基础上继续迭代功能或修 bug。
