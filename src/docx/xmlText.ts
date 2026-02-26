/**
 * OOXML 文本需要进行 XML 实体转义/反转义。
 *
 * 设计原因：
 * - Word 的 `w:t` 节点内容是 XML 文本，直接正则提取会包含 `&amp;` 等实体；
 * - 改写回写时如果不转义，容易产出非法 XML，导致 docx 打不开。
 */
export function decodeXmlText(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function encodeXmlText(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

