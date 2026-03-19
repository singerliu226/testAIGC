import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluateCnkiAlignmentSamples,
  type CnkiAlignmentSample,
} from "../analysis/cnkiEvaluation.js";

/**
 * 从单个 JSON 文件或目录批量加载知网对齐样本。
 *
 * 设计原因：
 * - 当前真实样本会逐篇累积，目录批量扫描比手工维护一个巨型文件更稳妥；
 * - 保留单文件模式，兼容早期示例与临时实验数据。
 */
export async function loadCnkiAlignmentSamples(inputPath: string): Promise<CnkiAlignmentSample[]> {
  const stats = await stat(inputPath);
  if (stats.isDirectory()) {
    const entries = await readdir(inputPath, { withFileTypes: true });
    const nested = await Promise.all(
      entries
        .filter(
          (entry) =>
            (entry.isDirectory() && entry.name !== "examples") ||
            (entry.isFile() &&
              extname(entry.name).toLowerCase() === ".json" &&
              !entry.name.endsWith(".example.json"))
        )
        .map((entry) => loadCnkiAlignmentSamples(join(inputPath, entry.name)))
    );
    return nested.flat();
  }

  const raw = await readFile(inputPath, "utf-8");
  const parsed = JSON.parse(raw) as CnkiAlignmentSample | CnkiAlignmentSample[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function main(): Promise<void> {
  const inputPath =
    process.argv[2] ??
    resolve(process.cwd(), "data/cnki-calibration");
  const samples = await loadCnkiAlignmentSamples(inputPath);
  const metrics = evaluateCnkiAlignmentSamples(samples);

  console.log(
    JSON.stringify(
      {
        inputPath,
        sampleCount: samples.length,
        documentIds: samples.map((sample) => sample.documentId),
        metrics,
      },
      null,
      2
    )
  );
}

const isEntrypoint =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
}
