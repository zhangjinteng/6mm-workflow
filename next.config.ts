import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["xlsx", "joplin-turndown-plugin-gfm", "pdfjs-dist"],
  outputFileTracingExcludes: {
    "/*": [
      "./.git/**/*",
      "./.codex/**/*",
      "./.env*",
      "./.workflow-data/**/*",
      "./tests/**/*",
    ],
  },
  outputFileTracingIncludes: {
    "/api/workflow/nodes/*": [
      "./workers/**/*",
      "./node_modules/just-bash/**/*",
      "./node_modules/.pnpm/{just-bash@*,run@*}/node_modules/**/*",
      "./node_modules/.pnpm/{pdfjs-dist*,@napi-rs+canvas*,mammoth*,turndown*,joplin-turndown*,xlsx*,jszip*,iconv-lite*,papaparse*}/**/*",
    ],
  },
};
export default nextConfig;
