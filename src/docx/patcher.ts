import JSZip from "jszip";
import { splitDocumentXmlIntoParts } from "./documentXml.js";
import { encodeXmlText } from "./xmlText.js";

export type ParagraphReplacementMap = Record<string, string>;

/**
 * 在原始 docx 上按段落替换文本，尽量保留排版。
 *
 * 设计原因：
 * - “保排版”的核心是：不重建整个文档，只替换 `<w:t>` 的内容；这样段落样式、编号、缩进等 `w:pPr` 保持不变。
 * - 与“重生成docx”相比，这种方式更接近学校系统对版式不敏感的实际需求。
 *
 * 实现方式：
 * - 读取 `word/document.xml`，按 `<w:p>` 切片得到与解析一致的段落 id（p-0, p-1...）。
 * - 若段落存在 `<w:t>`，替换第一个 `<w:t>` 的内容为新文本，并将其余 `<w:t>` 清空（保留 run 结构与样式）。
 * - 若段落没有 `<w:t>`（极少），则退化为插入一个最小 `<w:r><w:t>`。
 */
export async function patchDocxParagraphs(
  originalDocx: Buffer,
  replacements: ParagraphReplacementMap
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(originalDocx);
  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) throw new Error("Invalid docx: missing word/document.xml");

  const documentXml = await docXmlFile.async("text");
  const { parts } = splitDocumentXmlIntoParts(documentXml);

  const newParts = parts.map((p) => {
    if (p.type !== "paragraph") return p;
    const nextText = replacements[p.paragraph.id];
    if (typeof nextText !== "string") return p;
    return {
      ...p,
      paragraph: {
        ...p.paragraph,
        xml: replaceParagraphTextInXml(p.paragraph.xml, nextText),
      },
    };
  });

  const nextDocumentXml = newParts
    .map((p) => (p.type === "chunk" ? p.xml : p.paragraph.xml))
    .join("");

  zip.file("word/document.xml", nextDocumentXml);
  return zip.generateAsync({ type: "nodebuffer" });
}

function replaceParagraphTextInXml(paragraphXml: string, nextTextRaw: string): string {
  const nextText = encodeXmlText(nextTextRaw);

  const tRe = /<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g;
  const matches = Array.from(paragraphXml.matchAll(tRe));
  if (!matches.length) {
    // 没有任何文本节点：插入一个最小的 run（尽量不碰 pPr）
    const hasPPr = /<w:pPr\b[\s\S]*?<\/w:pPr>/.test(paragraphXml);
    const insertAfter = hasPPr ? /(<w:pPr\b[\s\S]*?<\/w:pPr>)/ : /(<w:p\b[^>]*>)/;
    const run = `<w:r><w:t xml:space="preserve">${nextText}</w:t></w:r>`;
    return paragraphXml.replace(insertAfter, `$1${run}`);
  }

  let out = paragraphXml;
  // 1) 替换第一个 w:t 内容
  const first = matches[0];
  const firstAttr = first[1] ?? "";
  const firstTag =
    /xml:space=/.test(firstAttr) ? `<w:t${firstAttr}>` : `<w:t${firstAttr} xml:space="preserve">`;
  out = out.replace(first[0], `${firstTag}${nextText}</w:t>`);

  // 2) 清空其余 w:t 内容，保留结构与样式
  for (let i = 1; i < matches.length; i += 1) {
    const m = matches[i];
    const attr = m[1] ?? "";
    out = out.replace(m[0], `<w:t${attr}></w:t>`);
  }

  return out;
}

