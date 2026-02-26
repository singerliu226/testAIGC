import JSZip from "jszip";
import { splitDocumentXmlIntoParts, type DocxParagraph, type DocumentXmlParts } from "./documentXml.js";

export type ParsedDocx = {
  /** 原始 docx buffer */
  original: Buffer;
  /** `word/document.xml` 原文（UTF-8 字符串） */
  documentXml: string;
  /** 切片结果（chunk/paragraph 交替） */
  parts: DocumentXmlParts[];
  /** 段落列表（按出现顺序） */
  paragraphs: DocxParagraph[];
};

/**
 * 解析 `.docx`，抽取段落与 `document.xml` 切片。
 *
 * 设计原因：
 * - `.docx` 本质是 zip + OOXML；我们需要拿到原始 `document.xml` 以实现“局部回写”。
 * - 解析阶段只做“最必要的信息抽取”，避免过早重建 OOXML 破坏排版。
 *
 * 实现方式：
 * - 使用 `jszip` 解压并读取 `word/document.xml`；
 * - 使用 `splitDocumentXmlIntoParts()` 保留 chunk/paragraph 顺序与每个段落原始 XML。
 */
export async function parseDocx(buffer: Buffer): Promise<ParsedDocx> {
  const zip = await JSZip.loadAsync(buffer);
  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) {
    throw new Error("Invalid docx: missing word/document.xml");
  }

  const documentXml = await docXmlFile.async("text");
  const { parts, paragraphs } = splitDocumentXmlIntoParts(documentXml);

  return {
    original: buffer,
    documentXml,
    parts,
    paragraphs,
  };
}

