import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production") || process.env.NODE_ENV === "production";

mkdirSync("dist/webview", { recursive: true });
cpSync("node_modules/@vscode/codicons/dist/codicon.css", "dist/webview/codicon.css");
cpSync("node_modules/@vscode/codicons/dist/codicon.ttf", "dist/webview/codicon.ttf");

/** @type {import('esbuild').BuildOptions} */
const extension = {
  entryPoints: ["src/extension/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  entryPoints: ["src/webview/main.tsx"],
  bundle: true,
  outfile: "dist/webview/main.js",
  platform: "browser",
  target: "es2022",
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  loader: { ".css": "css" },
};

if (watch) {
  const [a, b] = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all([a.watch(), b.watch()]);
  console.log("watching…");
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
