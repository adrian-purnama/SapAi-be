import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

const nodeRequire = createRequire(import.meta.url);
const pdfjsDistDir = dirname(nodeRequire.resolve("pdfjs-dist/package.json"));

let pdfWorkerConfigured = false;

async function ensurePdfParseWorker(): Promise<void> {
  if (pdfWorkerConfigured) return;
  pdfWorkerConfigured = true;
  try {
    const workerPath = join(pdfjsDistDir, "legacy/build/pdf.worker.mjs");
    const { PDFParse } = await import("pdf-parse");
    PDFParse.setWorker(pathToFileURL(workerPath).href);
  } catch (e) {
    console.warn("[pdfTextExtract] Failed to configure PDF worker:", e instanceof Error ? e.message : e);
  }
}

function buildPdfParseLoadOptions(buffer: Buffer): Record<string, unknown> {
  const standardFontDir = join(pdfjsDistDir, "legacy/build/standard_fonts/");
  const cMapDir = join(pdfjsDistDir, "cmaps/");
  return {
    data: buffer,
    standardFontDataUrl: `${pathToFileURL(standardFontDir).href}/`,
    cMapUrl: `${pathToFileURL(cMapDir).href}/`,
    cMapPacked: true,
    useSystemFonts: true,
    disableFontFace: true,
    stopAtErrors: false,
  };
}

/** Trim leading garbage; many exporters prepend bytes before `%PDF-`. */
export function normalizePdfBuffer(buffer: Buffer): Buffer {
  const header = Buffer.from("%PDF-", "latin1");
  const maxScan = Math.min(buffer.length, 4096);
  for (let i = 0; i <= maxScan - header.length; i++) {
    if (buffer.subarray(i, i + header.length).equals(header)) {
      if (i === 0) return buffer;
      return buffer.subarray(i);
    }
  }
  return buffer;
}

function decodePdfEscapedString(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = inner[++i];
    if (next === undefined) break;
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "(":
      case ")":
      case "\\":
        out += next;
        break;
      case "\n":
      case "\r":
        break;
      default:
        if (next >= "0" && next <= "7") {
          let oct = next;
          for (let j = 0; j < 2 && i + 1 < inner.length; j++) {
            const d = inner[i + 1];
            if (d >= "0" && d <= "7") {
              oct += d;
              i++;
            } else break;
          }
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else {
          out += next;
        }
    }
  }
  return out;
}

function collectLiteralStrings(content: string): string[] {
  const texts: string[] = [];
  const re = /\((?:\\.|[^\\)])*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const decoded = decodePdfEscapedString(m[0].slice(1, -1)).trim();
    if (decoded.length >= 1 && isLikelyText(decoded)) {
      texts.push(decoded);
    }
  }
  return texts;
}

function isLikelyText(s: string): boolean {
  if (s.length === 0) return false;
  let printable = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 0xfffe)) printable++;
  }
  return printable / s.length >= 0.85;
}

function decompressPdfStreams(pdfLatin: string): string {
  const parts: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(pdfLatin)) !== null) {
    const before = pdfLatin.slice(Math.max(0, m.index - 1200), m.index);
    const isFlate = /\/FlateDecode|\/Fl\b/i.test(before);
    const raw = m[1] ?? "";
    if (!isFlate) {
      parts.push(raw);
      continue;
    }
    try {
      const buf = Buffer.from(raw, "latin1");
      parts.push(inflateSync(buf).toString("latin1"));
    } catch {
      parts.push(raw);
    }
  }
  return parts.join("\n");
}

/**
 * Best-effort text extraction when pdf.js rejects xref/catalog (common for simple exports).
 */
export function extractPdfTextHeuristic(buffer: Buffer): string {
  const normalized = normalizePdfBuffer(buffer);
  const latin = normalized.toString("latin1");
  const fromStreams = decompressPdfStreams(latin);
  const texts = [...collectLiteralStrings(fromStreams), ...collectLiteralStrings(latin)];
  const unique = [...new Set(texts)];
  return unique.join("\n").replace(/\s+\n/g, "\n").trim();
}

async function extractPdfWithPdfParse(buffer: Buffer): Promise<string> {
  await ensurePdfParseWorker();
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse(buildPdfParseLoadOptions(buffer) as ConstructorParameters<typeof PDFParse>[0]);
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

export async function extractPdfText(buffer: Buffer): Promise<{ text: string } | { error: string }> {
  const normalized = normalizePdfBuffer(buffer);
  if (normalized.length < 8 || !normalized.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
    return {
      error:
        "This file does not start with a PDF header (%PDF-). It may be corrupted, truncated, or not a real PDF despite the extension.",
    };
  }

  let primaryError = "";
  try {
    const text = (await extractPdfWithPdfParse(normalized)).trim();
    if (text.length > 0) {
      return { text };
    }
    primaryError = "No text extracted by the PDF parser.";
  } catch (e) {
    primaryError = e instanceof Error ? e.message : "PDF parse failed.";
  }

  try {
    const heuristic = extractPdfTextHeuristic(normalized).trim();
    if (heuristic.length > 0) {
      console.info("[pdfTextExtract] Used heuristic fallback after parser failure", {
        primaryError: primaryError.slice(0, 120),
        chars: heuristic.length,
      });
      return { text: heuristic };
    }
  } catch (e) {
    console.warn("[pdfTextExtract] Heuristic fallback failed:", e instanceof Error ? e.message : e);
  }

  return { error: primaryError || "Could not extract text from this PDF." };
}
