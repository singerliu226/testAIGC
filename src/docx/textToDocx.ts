import JSZip from "jszip";

/**
 * 将纯文本段落数组转换为最小合法 OOXML `.docx` Buffer。
 *
 * 设计原因：
 * - 纯文字粘贴入口的用户没有 .docx 文件；为了让后续的检测/改写/导出管道原样复用，
 *   需要在服务端生成一个结构合法的 docx，使 `parseDocx` 和 `patchDocxParagraphs` 都能正常工作。
 * - 保持最小化：只包含让 Word/LibreOffice 可以打开的必要 OOXML 文件，不附加样式/字体等。
 *
 * 实现方式：
 * - 用 JSZip 组装四个最小 OOXML 文件（Content_Types、_rels、document.xml、document.xml.rels）。
 * - 每个段落对应一个 `<w:p>`，文字放在 `<w:t xml:space="preserve">` 中，
 *   与 `patchDocxParagraphs` 的回写逻辑完全兼容。
 */
export async function textToDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();

  // [Content_Types].xml — 声明 docx 的 MIME 类型映射
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );

  // _rels/.rels — 包级关系：入口指向 word/document.xml
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>`
  );

  // word/_rels/document.xml.rels — 文档级关系（无附件时为空壳）
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`
  );

  // word/document.xml — 主文档：每个段落对应一个 <w:p>
  const paragraphXmls = paragraphs
    .map((text) => {
      // 对段落文字做 XML 实体编码，防止特殊字符破坏 XML 结构
      const escaped = escapeXml(text);
      return `  <w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`;
    })
    .join("\n");

  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:w10="urn:schemas-microsoft-com:office:word"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
  xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
  xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  mc:Ignorable="w14 wp14">
  <w:body>
${paragraphXmls}
    <w:sectPr/>
  </w:body>
</w:document>`
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

/**
 * XML 特殊字符转义，防止段落内容破坏 OOXML 文档结构。
 * 只处理 XML 层面的字符，不做 HTML 编码。
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
