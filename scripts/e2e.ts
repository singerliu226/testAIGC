import fs from "node:fs";
import path from "node:path";
import { parseDocx } from "../src/docx/parser.js";
import { detectAigcRisk } from "../src/analysis/detector.js";
import { patchDocxParagraphs } from "../src/docx/patcher.js";

/**
 * 本地端到端验证脚本（不调用云端模型）。
 *
 * 用法：
 * - `npx tsx scripts/e2e.ts /path/to/input.docx`
 *
 * 设计原因：
 * - CI/本地验证不能依赖 API Key；
 * - 只要能跑通“解析→检测→回写→导出”，就能证明核心链路可运行。
 */
async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("Usage: npx tsx scripts/e2e.ts /path/to/input.docx");
  }

  const abs = path.resolve(process.cwd(), inputPath);
  const buf = fs.readFileSync(abs);

  const parsed = await parseDocx(buf);
  const paragraphs = parsed.paragraphs.map((p) => ({
    id: p.id,
    index: p.index,
    kind: p.kind,
    text: p.text,
  }));
  const report = detectAigcRisk(paragraphs);

  const targets = report.paragraphReports
    .filter((r) => r.riskScore >= 35)
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 3);

  if (!targets.length && report.paragraphReports.length) {
    targets.push(report.paragraphReports[0]);
  }

  const replacements: Record<string, string> = {};
  for (const t of targets) {
    replacements[t.paragraphId] = `【本地修订示例】${t.text}`;
  }

  const revised = await patchDocxParagraphs(buf, replacements);

  const outDir = path.resolve(process.cwd(), "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "e2e-revised.docx");
  fs.writeFileSync(outPath, revised);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        input: abs,
        paragraphCount: parsed.paragraphs.length,
        overallRisk: {
          score: report.overallRiskScore,
          level: report.overallRiskLevel,
        },
        revisedParagraphs: targets.map((t) => ({ paragraphId: t.paragraphId, riskScore: t.riskScore })),
        output: outPath,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

