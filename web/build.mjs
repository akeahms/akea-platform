// Build: bundle src/ with esbuild into dist/, copy public/. Supabase URL and public key come from env (defaults below are public values).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://rqyvjloptxdfojaxjirq.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_Acg0lTpyf3hXxC6USntFFA_MKRwpkmV";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });
await build({
  entryPoints: { app: "src/main.tsx" },
  bundle: true,
  minify: true,
  sourcemap: true,
  target: ["es2020"],
  outdir: "dist",
  jsx: "automatic",
  define: {
    __SUPABASE_URL__: JSON.stringify(SUPABASE_URL),
    __SUPABASE_KEY__: JSON.stringify(SUPABASE_KEY),
    "process.env.NODE_ENV": '"production"',
  },
  logLevel: "info",
});
