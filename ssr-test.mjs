import { build } from "esbuild";

const ROOT = "D:\\AI学习\\工作台\\workbench";
const entry = `
import React from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import AiHotPage from "D:/AI学习/工作台/workbench/src/pages/AiHotPage.jsx";
import { PageHeader } from "D:/AI学习/工作台/workbench/src/components/PageHeader.jsx";

const results = [];
function tryRender(name, el) {
  try {
    const html = renderToString(el);
    results.push("OK   " + name + "  (len=" + html.length + ")");
  } catch (e) {
    results.push("FAIL " + name + "  -> " + (e && e.stack ? e.stack.split("\\n").slice(0,6).join("\\n") : e));
  }
}

tryRender("PageHeader(meta)", React.createElement(PageHeader, {
  eyebrow: "EXTERNAL SIGNALS · AI HOT", title: "每日热点",
  description: "聚合近期 AI 热点", meta: React.createElement("div", {className:"daily-hot-source"}, "x")
}));
tryRender("PageHeader(actions)", React.createElement(PageHeader, {
  eyebrow: "OVERVIEW", title: "概览面板", description: "d",
  actions: React.createElement("button", null, "btn")
}));
tryRender("AiHotPage(full)", React.createElement(MemoryRouter, null, React.createElement(AiHotPage)));

console.log(results.join("\\n"));
`;

const pluginStubApi = {
  name: "stub-api",
  setup(b) {
    b.onResolve({ filter: /src[\\/]api\.js$/ }, () => ({ path: "stub-api", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const api = { get: async () => ({}) };", loader: "js" }));
  },
};
const emptyCss = {
  name: "empty-css",
  setup(b) { b.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" })); },
};

const result = await build({
  stdin: { contents: entry, resolveDir: ROOT, loader: "jsx" },
  bundle: true, format: "esm", platform: "node", jsx: "automatic",
  plugins: [pluginStubApi, emptyCss], write: false,
  absWorkingDir: ROOT, logLevel: "silent",
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});

const code = result.outputFiles[0].text;
import { writeFileSync } from "node:fs";
writeFileSync("D:\\AI学习\\工作台\\workbench\\ssr-bundle.mjs", code);
console.log("=== bundle written, now executing ===");
await import("file:///D:/AI%E5%AD%A6%E4%B9%A0/%E5%B7%A5%E4%BD%9C%E5%8F%B0/workbench/ssr-bundle.mjs");
