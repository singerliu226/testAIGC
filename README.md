# 论文盾 — AI率检测与智能降重

上传 `.docx` 学术论文 → 生成段落级 AI 率检测报告 → 一键/逐段智能改写降低 AI 痕迹 → 导出保留排版的修订版 `.docx`。

对齐知网/万方/维普 AIGC 检测标准（AI 字符数占比算法），适用于高校毕业论文降 AI 率场景。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

在 `.env` 中填写：

| 变量 | 说明 | 必填 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 阿里云百炼 / DashScope API Key | 是（改写功能） |
| `DASHSCOPE_BASE_URL` | API 地址，默认北京节点 | 否 |
| `DASHSCOPE_MODEL` | 模型名，默认 `qwen-plus-latest` | 否 |
| `ADMIN_SECRET` | 管理员密码（用于后台积分管理） | 否 |
| `PORT` | 服务端口，默认 `8787` | 否 |

### 3. 构建 & 启动

```bash
npm run build
npm start
```

浏览器打开 `http://localhost:8787`

### 开发模式

```bash
npm run dev
```

## Zeabur 部署

1. Fork 或推送本仓库到 GitHub
2. 在 [Zeabur](https://zeabur.com) 创建项目，导入 GitHub 仓库
3. 在 Zeabur 环境变量中配置 `DASHSCOPE_API_KEY`、`ADMIN_SECRET` 等
4. Zeabur 会自动执行 `npm run build` 并通过 `npm start` 启动服务
5. 绑定域名后即可使用

## 技术栈

- **后端**: Node.js + Express + TypeScript
- **前端**: 原生 HTML/CSS/JS（零框架，单页应用）
- **LLM**: 阿里云通义千问（DashScope OpenAI 兼容接口）
- **文档处理**: JSZip + fast-xml-parser（解析/回写 .docx）
- **检测引擎**: 规则引擎 + LLM 二次审核，7 大维度 20+ 检测规则
- **计费**: 文件积分系统，管理员后台

## 项目结构

```
src/
├── analysis/       # AIGC 检测引擎（特征提取、规则检测、词典）
├── billing/        # 积分计费系统
├── docx/           # .docx 解析与回写
├── llm/            # LLM 调用（改写、审核、对话）
├── logger/         # Winston 日志模块
├── report/         # 报告数据结构
├── server/         # Express 服务、路由、Session 存储
└── index.ts        # 入口
web/
├── index.html      # 主页面
└── admin.html      # 管理员后台
```
