#!/usr/bin/env node
// scripts/dump-hays-pdf-text.mts — one-off: print raw PDF text for Hays guide inspection.
import { readFile } from "node:fs/promises";
import path from "node:path";
import PDFParser from "pdf2json";

const pdfPath =
  process.argv[2] ??
  path.join(process.cwd(), "storage", "HU-Hays Hungary Salary Guide 2026.pdf");

const buf = await readFile(pdfPath);
const text = await new Promise<string>((resolve, reject) => {
  const parser = new PDFParser(null, true);
  parser.on("pdfParser_dataError", (err) => reject(err));
  parser.on("pdfParser_dataReady", () => {
    resolve(parser.getRawTextContent() ?? "");
    parser.destroy();
  });
  parser.parseBuffer(buf);
});

process.stdout.write(text.slice(0, 120_000));
