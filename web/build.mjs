// Build: bundle src/ with esbuild into dist/, copy public/. Supabase URL and public key come from env (defaults below are public values).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://rqyvjloptxdfojaxjirq.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_Acg0lTpyf3hXxC6USntFFA_MKRwpkmV";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });
// Content security policy: the app, its Supabase project, Google Fonts, and Plaid (only used when connecting a bank).
const sb = new URL(SUPABASE_URL);
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.plaid.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  `connect-src 'self' ${sb.origin} wss://${sb.host} https://*.plaid.com`,
  "frame-src https://cdn.plaid.com https://*.plaid.com blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
writeFileSync("dist/index.html", readFileSync("dist/index.html", "utf8").replace("__CSP__", CSP));
// PDF reading runs in a web worker; ship the worker next to the app
copyFileSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "dist/pdf.worker.min.mjs");
await build({
  entryPoints: { app: "src/main.tsx" },
  bundle: true,
  minify: true,
  sourcemap: true,
  target: ["es2022"],
  format: "esm",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  outdir: "dist",
  jsx: "automatic",
  define: {
    __SUPABASE_URL__: JSON.stringify(SUPABASE_URL),
    __SUPABASE_KEY__: JSON.stringify(SUPABASE_KEY),
    "process.env.NODE_ENV": '"production"',
  },
  logLevel: "info",
});
