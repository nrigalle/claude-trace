import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const prod = !watch;

const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18.17",
  sourcemap: true,
  minify: prod,
  treeShaking: true,
  legalComments: "none",
  drop: prod ? ["debugger"] : [],
  logLevel: "info",
  tsconfig: "tsconfig.json",
};

const webviewConfig = {
  entryPoints: ["media/src/main.ts"],
  bundle: true,
  outfile: "media/dashboard.js",
  format: "iife",
  platform: "browser",
  target: ["es2022", "chrome120"],
  sourcemap: prod ? "linked" : "inline",
  minify: prod,
  treeShaking: true,
  legalComments: "none",
  logLevel: "info",
  tsconfig: "tsconfig.webview.json",
};

const configs = [extensionConfig, webviewConfig];

if (watch) {
  for (const c of configs) {
    const ctx = await esbuild.context(c);
    await ctx.watch();
  }
  console.log("Watching extension and webview for changes...");
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log("Build complete (extension + webview).");
}
