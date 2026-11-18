import { getDocument as loadDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
export function getDocument(options) {
  return loadDocument({
    ...options,
    cMapUrl: path.join(root, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(root, "standard_fonts") + path.sep,
    isEvalSupported: false,
  });
}
