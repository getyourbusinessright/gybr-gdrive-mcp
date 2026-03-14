/**
 * DOCX Builder - Creates Word documents from markdown-style content
 */

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, LevelFormat
} from "docx";

/**
 * Parse simple markdown-style content into docx paragraphs
 * Supports: # H1, ## H2, ### H3, **bold**, - bullets, blank lines
 */
function parseContent(content) {
  const lines = content.split("\n");
  const paragraphs = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      paragraphs.push(new Paragraph({ children: [] }));
      continue;
    }

    // H1
    if (trimmed.startsWith("# ")) {
      paragraphs.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: trimmed.slice(2), bold: true, size: 32, font: "Arial" })],
      }));
      continue;
    }

    // H2
    if (trimmed.startsWith("## ")) {
      paragraphs.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: trimmed.slice(3), bold: true, size: 28, font: "Arial" })],
      }));
      continue;
    }

    // H3
    if (trimmed.startsWith("### ")) {
      paragraphs.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [new TextRun({ text: trimmed.slice(4), bold: true, size: 24, font: "Arial" })],
      }));
      continue;
    }

    // Bullet
    if (trimmed.startsWith("- ")) {
      paragraphs.push(new Paragraph({
        numbering: { reference: "bullets", level: 0 },
        children: parseInline(trimmed.slice(2)),
      }));
      continue;
    }

    // Normal paragraph
    paragraphs.push(new Paragraph({ children: parseInline(trimmed) }));
  }

  return paragraphs;
}

/**
 * Parse inline **bold** markers
 */
function parseInline(text) {
  const runs = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**")) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true, font: "Arial", size: 24 }));
    } else {
      runs.push(new TextRun({ text: part, font: "Arial", size: 24 }));
    }
  }
  return runs;
}

export async function createDocxBuffer(title, content) {
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [{
            level: 0,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          }],
        },
      ],
    },
    styles: {
      default: { document: { run: { font: "Arial", size: 24 } } },
      paragraphStyles: [
        {
          id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 32, bold: true, font: "Arial", color: "1F3864" },
          paragraph: { spacing: { before: 300, after: 150 }, outlineLevel: 0 },
        },
        {
          id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 28, bold: true, font: "Arial", color: "2E74B5" },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 },
        },
        {
          id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 24, bold: true, font: "Arial" },
          paragraph: { spacing: { before: 180, after: 60 }, outlineLevel: 2 },
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children: parseContent(content),
    }],
  });

  return await Packer.toBuffer(doc);
}
