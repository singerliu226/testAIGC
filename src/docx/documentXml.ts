import { decodeXmlText } from "./xmlText.js";

export type DocxParagraphKind = "paragraph" | "tableCellParagraph";

export type DocxParagraph = {
  id: string;
  index: number;
  kind: DocxParagraphKind;
  /**
   * 段落纯文本（已反转义）。
   * - `\\t` 来自 `<w:tab/>`
   * - `\\n` 来自 `<w:br/>` / `<w:cr/>`
   */
  text: string;
  /** 该段落在 `word/document.xml` 中的完整 `<w:p>...</w:p>` 片段（原样保留）。 */
  xml: string;
};

export type DocumentXmlParts =
  | { type: "chunk"; xml: string }
  | { type: "paragraph"; paragraph: DocxParagraph };

/**
 * 从 `word/document.xml` 中按顺序提取段落（含表格单元格内段落）。
 *
 * 设计原因：
 * - “尽量保排版”的关键是：不要重建整份 OOXML，而是对既有 `<w:p>` 进行“局部替换”。
 * - 解析阶段先保留每个 `<w:p>` 的原始 XML，后续回写只替换其内部文本 run。
 *
 * 实现方式：
 * - 用正则做 **流式切片**：把 document.xml 分成 chunk 与 paragraph 交替的 parts。
 * - 同时用 `w:tc` 深度粗略判断“是否来自表格单元格”，便于 UI 标注。
 */
export function splitDocumentXmlIntoParts(documentXml: string): {
  parts: DocumentXmlParts[];
  paragraphs: DocxParagraph[];
} {
  const parts: DocumentXmlParts[] = [];
  const paragraphs: DocxParagraph[] = [];

  const paragraphRe = /<w:p\b[\s\S]*?<\/w:p>/g;

  let lastIndex = 0;
  let paraIndex = 0;
  let tcDepth = 0;

  function updateTableCellDepth(xmlChunk: string) {
    // 这不是完整 XML 解析，只是用于“粗标注”。
    const openRe = /<w:tc\b/g;
    const closeRe = /<\/w:tc>/g;
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(xmlChunk))) tcDepth += 1;
    while ((m = closeRe.exec(xmlChunk))) tcDepth = Math.max(0, tcDepth - 1);
  }

  let match: RegExpExecArray | null;
  while ((match = paragraphRe.exec(documentXml))) {
    const start = match.index;
    const end = paragraphRe.lastIndex;

    const before = documentXml.slice(lastIndex, start);
    if (before) {
      updateTableCellDepth(before);
      parts.push({ type: "chunk", xml: before });
    }

    const paraXml = match[0];
    const kind: DocxParagraphKind = tcDepth > 0 ? "tableCellParagraph" : "paragraph";

    const paragraph: DocxParagraph = {
      id: `p-${paraIndex}`,
      index: paraIndex,
      kind,
      text: extractParagraphText(paraXml),
      xml: paraXml,
    };

    parts.push({ type: "paragraph", paragraph });
    paragraphs.push(paragraph);

    // 更新深度：段落内也可能包含 tc（极少），保险起见扫一下
    updateTableCellDepth(paraXml);

    paraIndex += 1;
    lastIndex = end;
  }

  const tail = documentXml.slice(lastIndex);
  if (tail) parts.push({ type: "chunk", xml: tail });

  return { parts, paragraphs };
}

/**
 * 从 `<w:p>...</w:p>` 中提取纯文本。
 *
 * 设计原因：
 * - 检测/改写通常基于“可阅读文本”；
 * - OOXML 的 run 可能被拆成多段 `<w:t>`，需要按出现顺序拼接。
 *
 * 实现方式：
 * - 以“扫描 token”的方式按序匹配：`<w:t>`、`<w:tab/>`、`<w:br/>`、`<w:cr/>`；
 * - 对 `<w:t>` 进行 XML 实体反转义。
 */
export function extractParagraphText(paragraphXml: string): string {
  const tokenRe =
    /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*\/>|<w:cr\s*\/>/g;

  let out = "";
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(paragraphXml))) {
    if (m[1] !== undefined) {
      out += decodeXmlText(m[1]);
    } else {
      const token = m[0];
      if (token.startsWith("<w:tab")) out += "\t";
      else out += "\n";
    }
  }

  // Word 段落末尾常有大量空白 run，保留对检测意义不大，这里做轻度 trim。
  return out.replace(/[\u00A0\s]+$/g, "");
}

