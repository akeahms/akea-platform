// Build: the company website (static pages from site/) at the root of dist/, and the suite (React app) under dist/app/.
// One domain, no subdomains: akeahms.com = website, akeahms.com/app/ = Akea AI Suite.
// Supabase URL and public key come from env (defaults below are public values). APP_NAME is this deployment's
// product name for the install icon (white-label; the name inside the app comes from the company's settings).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { buildSite } from "./site/build-site.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://rqyvjloptxdfojaxjirq.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_Acg0lTpyf3hXxC6USntFFA_MKRwpkmV";
const SITE_URL = process.env.SITE_URL || "https://akeahms.com";
const APP_NAME = process.env.APP_NAME || "Akea AI Suite";
const SITE = process.env.SITE !== "off";            // white-label deployments without a company website: SITE=off
const APP = "dist/app";

rmSync("dist", { recursive: true, force: true });
mkdirSync(APP, { recursive: true });
cpSync("public", APP, { recursive: true });

// the suite's security policy: the app, its Supabase project, Google Fonts, and Plaid (only used when connecting a bank)
const sb = new URL(SUPABASE_URL);
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.plaid.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src 'self' data: blob: ${sb.origin} https:`,
  `connect-src 'self' ${sb.origin} https://*.plaid.com`,
  "frame-src https://cdn.plaid.com https://*.plaid.com blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
// PDF reading runs in a web worker; ship the worker next to the app
copyFileSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", `${APP}/pdf.worker.min.mjs`);
const result = await build({
  entryPoints: { app: "src/main.tsx" },
  bundle: true,
  minify: true,
  sourcemap: false,                                  // source maps aren't published
  target: ["es2022"],
  format: "esm",
  splitting: true,
  entryNames: "[name]-[hash]",                       // a new file name each release, so cached pages never load a mismatched part
  chunkNames: "chunks/[name]-[hash]",
  outdir: APP,
  metafile: true,
  jsx: "automatic",
  define: {
    __SUPABASE_URL__: JSON.stringify(SUPABASE_URL),
    __SUPABASE_KEY__: JSON.stringify(SUPABASE_KEY),
    "process.env.NODE_ENV": '"production"',
  },
  logLevel: "warning",
});
const outs = Object.keys(result.metafile.outputs).map((p) => p.replace(`${APP}/`, ""));
const js = outs.find((p) => /^app-[\w]+\.js$/.test(p)), css = outs.find((p) => /^app-[\w]+\.css$/.test(p));
writeFileSync(`${APP}/index.html`, readFileSync(`${APP}/index.html`, "utf8").replace("__CSP__", CSP).replace("__JS__", js).replace("__CSS__", css));
writeFileSync(`${APP}/manifest.webmanifest`, readFileSync(`${APP}/manifest.webmanifest`, "utf8").replaceAll("__APP_NAME__", APP_NAME.replace(/"/g, "")));

if (SITE) buildSite("dist", { supabaseUrl: SUPABASE_URL, siteUrl: SITE_URL, appPath: "/app/" });
else writeFileSync("dist/index.html", `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/app/"><a href="/app/">Open the app</a>`);

const kb = (p) => Math.round(result.metafile.outputs[`${APP}/${p}`].bytes / 1024);
console.log(`app: ${js} ${kb(js)} KB · ${css} ${kb(css)} KB · ${outs.filter((p) => p.startsWith("chunks/")).length} on-demand parts${SITE ? " · website built" : ""}`);
