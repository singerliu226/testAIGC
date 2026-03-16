import { decodeXmlText } from "./xmlText.js";

export type DocxParagraphKind = "paragraph" | "tableCellParagraph" | "imageParagraph";

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
 * 用手动栈扫描（计数器法）屏蔽指定标签的所有顶层块，替换为编号占位符。
 *
 * 设计原因：
 * - 正则 `/<tag\b[\s\S]*?<\/tag>/g` 对于可能嵌套同名标签的结构（如 `mc:AlternateContent`
 *   嵌套 `mc:AlternateContent`）会产生灾难性回溯，在体积较大的 XML 中耗时可达数十秒。
 * - `indexOf` 线性扫描配合深度计数器，时间复杂度严格 O(n)，彻底消除回溯风险。
 *
 * 实现方式：
 * - 找到开标签 `<tagName` 后，用 depth 计数器追踪嵌套深度，直到匹配的闭标签 `</tagName>`。
 * - 每个顶层块整体推入 `map`，原位写入 `\x00SHIELD{i}\x00`。
 * - 遇到格式错误（找不到闭标签）时原样保留，不会崩溃。
 */
function shieldTagBlocks(xml: string, tagName: string, map: string[]): string {
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  let result = "";
  let pos = 0;

  while (pos < xml.length) {
    const openIdx = xml.indexOf(openTag, pos);
    if (openIdx === -1) {
      result += xml.slice(pos);
      break;
    }

    // openTag 后必须紧跟空白或 `>`，防止误匹配前缀相同的标签（如 <mc:AlternateContentX）
    const afterOpen = xml[openIdx + openTag.length];
    if (afterOpen !== " " && afterOpen !== "\t" && afterOpen !== "\n" && afterOpen !== "\r" && afterOpen !== ">" && afterOpen !== "/") {
      result += xml.slice(pos, openIdx + openTag.length);
      pos = openIdx + openTag.length;
      continue;
    }

    result += xml.slice(pos, openIdx);

    // 从 openIdx+openTag.length 开始（跳过外层开标签名本身），用计数器找到匹配的闭标签。
    // 设计原因：若从 openIdx 开始，innerHTML 第一次 indexOf 会再次命中外层开标签，
    // 使 depth 多被累加 1，导致配对的闭标签被当成"内层闭标签"消耗掉，永远找不到匹配 → found = false。
    // 跳过标签名后 depth 从 0 开始，首次遇到 close tag 即为匹配的外层闭标签。
    let depth = 0;
    let scanPos = openIdx + openTag.length;
    let found = false;

    while (scanPos < xml.length) {
      const nextOpen = xml.indexOf(openTag, scanPos);
      const nextClose = xml.indexOf(closeTag, scanPos);

      if (nextClose === -1) break; // 格式错误，放弃

      if (nextOpen !== -1 && nextOpen < nextClose) {
        // 确认是同名标签的开标签（非前缀匹配）
        const ch = xml[nextOpen + openTag.length];
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ">" || ch === "/") {
          depth++;
          scanPos = nextOpen + openTag.length;
        } else {
          scanPos = nextOpen + openTag.length;
        }
      } else {
        if (depth === 0) {
          const endIdx = nextClose + closeTag.length;
          const block = xml.slice(openIdx, endIdx);
          const idx = map.length;
          map.push(block);
          result += `\x00SHIELD${idx}\x00`;
          pos = endIdx;
          found = true;
          break;
        }
        depth--;
        scanPos = nextClose + closeTag.length;
      }
    }

    if (!found) {
      // 格式异常，保留原样继续
      result += xml.slice(openIdx, openIdx + openTag.length);
      pos = openIdx + openTag.length;
    }
  }

  return result;
}

/**
 * 屏蔽 XML 中包含嵌套 `<w:p>` 的容器结构，替换为编号占位符。
 *
 * 设计原因：
 * - OOXML 多图论文中，每张图片通常对应一个 `<mc:AlternateContent>` 包装，
 *   内部含 `<mc:Choice>/<w:drawing>` 和 `<mc:Fallback>/<v:pict>` 两条支路，
 *   单块 XML 体积可达数万字符；`<v:shape>`、`<v:pict>` 等 VML 回退格式同样庞大。
 * - 原来使用正则 `[\s\S]*?<\/\1>` 对这些大型块做懒惰匹配，在嵌套同名标签时
 *   会触发灾难性回溯，导致 50 张图的论文解析耗时超过 50 秒。
 * - 改为 `shieldTagBlocks`（栈扫描，O(n)）后彻底消除回溯风险。
 *
 * 屏蔽顺序：
 * 1. `<w:drawing>`：DrawingML 主体，最先屏蔽后可大幅缩减后续标签需扫描的字符量。
 * 2. `<mc:AlternateContent>`：图片的 Word 兼容容器，每张图对应一个，体积大且可嵌套。
 * 3. `<v:shape>`、`<v:pict>`：VML 回退格式（`mc:Fallback` 里），体积同样很大。
 * 4. `<wps:txbx>`、`<w:txbxContent>`、`<v:textbox>`：文本框，含内层 `<w:p>`。
 */
function shieldNestedBlocks(xml: string): { xml: string; map: string[] } {
  const map: string[] = [];

  // 按顺序逐标签屏蔽，顺序很重要：先屏蔽内层，再屏蔽外层，每轮扫描量依次缩减
  const tagsToShield = [
    "w:drawing",          // DrawingML 主体（最大、最先）
    "mc:AlternateContent", // 图片兼容容器（每张图一个）
    "v:shape",            // VML 图形回退
    "v:pict",             // VML 图片回退
    "wps:txbx",           // 文本框（含嵌套 <w:p>）
    "w:txbxContent",      // 文本框内容（含嵌套 <w:p>）
    "v:textbox",          // VML 文本框（含嵌套 <w:p>）
  ];

  let current = xml;
  for (const tag of tagsToShield) {
    current = shieldTagBlocks(current, tag, map);
  }

  return { xml: current, map };
}

/**
 * 将占位符还原为原始 XML 片段。
 */
function restoreShields(xml: string, map: string[]): string {
  return xml.replace(/\x00SHIELD(\d+)\x00/g, (_, i) => map[Number(i)]);
}

/**
 * 包含这些 XML 信号的段落被视为图片/图形段落，改写时跳过以防止格式损坏。
 *
 * 设计原因：
 * - 修复 shieldTagBlocks 后，屏蔽成功：image paragraph XML 经 restoreShields 还原后，
 *   `<w:drawing>` 仍在嵌套 shield 占位符内（不可见），但外层 `<mc:AlternateContent>` 或
 *   VML fallback 的 `<v:shape>` / `<v:pict>` 会直接暴露在还原后的 XML 里。
 * - 加入 `<mc:AlternateContent` 作为兜底信号，确保纯 DrawingML 且 fallback 为空的极少情况
 *   也能正确标记为图片段落。
 */
const IMAGE_SIGNALS = ["<w:drawing", "<wps:wsp", "<v:shape", "<v:pict", "<mc:AlternateContent"];

/**
 * 从 `word/document.xml` 中按顺序提取段落（含表格单元格内段落）。
 *
 * 设计原因：
 * - "尽量保排版"的关键是：不要重建整份 OOXML，而是对既有 `<w:p>` 进行"局部替换"。
 * - 解析阶段先保留每个 `<w:p>` 的原始 XML，后续回写只替换其内部文本 run。
 * - 对含图片/图形的段落打 `imageParagraph` 标记，patching 时跳过以防格式损坏。
 *
 * 实现方式：
 * - 先调用 `shieldNestedBlocks` 屏蔽可能含嵌套 `<w:p>` 的结构，消除正则配对歧义。
 * - 对屏蔽后的 XML 用正则做 **流式切片**，再逐段调用 `restoreShields` 还原。
 * - 同时用 `w:tc` 深度粗略判断"是否来自表格单元格"，便于 UI 标注。
 */
export function splitDocumentXmlIntoParts(documentXml: string): {
  parts: DocumentXmlParts[];
  paragraphs: DocxParagraph[];
} {
  const parts: DocumentXmlParts[] = [];
  const paragraphs: DocxParagraph[] = [];

  // 屏蔽含嵌套 <w:p> 的容器结构，防止正则误配对导致段落 ID 错位
  const { xml: shieldedXml, map: shieldMap } = shieldNestedBlocks(documentXml);

  const paragraphRe = /<w:p\b[\s\S]*?<\/w:p>/g;

  let lastIndex = 0;
  let paraIndex = 0;
  let tcDepth = 0;

  function updateTableCellDepth(xmlChunk: string) {
    // 这不是完整 XML 解析，只是用于"粗标注"。
    const openRe = /<w:tc\b/g;
    const closeRe = /<\/w:tc>/g;
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(xmlChunk))) tcDepth += 1;
    while ((m = closeRe.exec(xmlChunk))) tcDepth = Math.max(0, tcDepth - 1);
  }

  let match: RegExpExecArray | null;
  while ((match = paragraphRe.exec(shieldedXml))) {
    const start = match.index;
    const end = paragraphRe.lastIndex;

    // 还原 before chunk 中的屏蔽块
    const beforeShielded = shieldedXml.slice(lastIndex, start);
    if (beforeShielded) {
      const before = restoreShields(beforeShielded, shieldMap);
      updateTableCellDepth(before);
      parts.push({ type: "chunk", xml: before });
    }

    // 还原段落 XML 中的屏蔽块（如文本框内容）
    const paraXml = restoreShields(match[0], shieldMap);

    const isImageParagraph = IMAGE_SIGNALS.some((s) => paraXml.includes(s));
    const kind: DocxParagraphKind = isImageParagraph
      ? "imageParagraph"
      : tcDepth > 0
      ? "tableCellParagraph"
      : "paragraph";

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

  // 还原尾部 chunk 中的屏蔽块
  const tailShielded = shieldedXml.slice(lastIndex);
  if (tailShielded) {
    parts.push({ type: "chunk", xml: restoreShields(tailShielded, shieldMap) });
  }

  return { parts, paragraphs };
}

/**
 * 从 `<w:p>...</w:p>` 中提取纯文本。
 *
 * 设计原因：
 * - 检测/改写通常基于"可阅读文本"；
 * - OOXML 的 run 可能被拆成多段 `<w:t>`，需要按出现顺序拼接。
 *
 * 实现方式：
 * - 以"扫描 token"的方式按序匹配：`<w:t>`、`<w:tab/>`、`<w:br/>`、`<w:cr/>`；
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
