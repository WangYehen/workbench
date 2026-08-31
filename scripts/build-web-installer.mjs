import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const buildRoot = path.join(root, ".web-build");
const stageDir = path.join(buildRoot, version);
const versionDir = path.join(stageDir, "version");
const appDir = path.join(versionDir, "app");
const runtimeDir = path.join(versionDir, "runtime");
const outputDir = path.join(root, "release-web");
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || `${command} exited with ${result.status}`;
    throw new Error(detail.trim());
  }
  return result.stdout?.trim() || "";
}

async function findFiles(directory, name, depth = 4) {
  if (depth < 0 || !fs.existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) found.push(target);
    else if (entry.isDirectory()) found.push(...await findFiles(target, name, depth - 1));
  }
  return found;
}

async function findMakensis() {
  if (process.env.MAKENSIS_PATH && fs.existsSync(process.env.MAKENSIS_PATH)) return process.env.MAKENSIS_PATH;
  try {
    const found = run("where.exe", ["makensis.exe"], { capture: true }).split(/\r?\n/).find(Boolean);
    if (found) return found;
  } catch { /* 继续检查 electron-builder 缓存。 */ }
  const cacheRoot = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "nsis");
  const candidates = await findFiles(cacheRoot, "makensis.exe");
  const binCandidate = candidates.find((candidate) => path.basename(path.dirname(candidate)).toLowerCase() === "bin");
  if (binCandidate || candidates[0]) return binCandidate || candidates[0];
  throw new Error("未找到 makensis.exe。请安装 NSIS，或通过 MAKENSIS_PATH 指定路径。");
}

if (process.platform !== "win32") throw new Error("Web 安装包当前仅支持在 Windows 上构建。");
if (!/^[0-9A-Za-z._-]+$/.test(version)) throw new Error(`package.json 版本号不适合安装目录：${version}`);
if (!process.execPath.toLowerCase().endsWith(".exe")) throw new Error("当前 Node 运行时不是 Windows node.exe。");
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 18)) throw new Error("构建安装包需要 Node.js 20.18 或更高版本。");

console.log(`[web-installer] building ${version}`);
run(process.execPath, [npmCli, "run", "build"]);

await rm(stageDir, { recursive: true, force: true });
await mkdir(appDir, { recursive: true });
await mkdir(runtimeDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

await cp(path.join(root, "dist", "client"), path.join(appDir, "dist", "client"), { recursive: true });
await cp(path.join(root, "server"), path.join(appDir, "server"), { recursive: true });
await cp(path.join(root, "package.json"), path.join(appDir, "package.json"));
await cp(path.join(root, "package-lock.json"), path.join(appDir, "package-lock.json"));

// 在隔离的 staging 目录安装生产依赖，避免把 Electron/Vite 等开发依赖带给领导。
run(process.execPath, [npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: appDir });
await cp(process.execPath, path.join(runtimeDir, "node.exe"));
await cp(path.join(root, "web-launcher"), path.join(stageDir, "launcher"), { recursive: true });
// Windows Script Host 不可靠地识别 UTF-8 VBS；发布时转成带 BOM 的 UTF-16LE，避免中文路径/提示语报“无效字符”。
for (const name of ["invoke.vbs", "message.vbs"]) {
  const target = path.join(stageDir, "launcher", name);
  const text = await readFile(target, "utf8");
  await writeFile(target, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
}
await cp(path.join(root, "installer", "app.env.example"), path.join(stageDir, "app.env.example"));

const manifest = {
  service: "team-daily-workbench",
  version,
  builtAt: new Date().toISOString(),
  node: process.version,
};
await writeFile(path.join(stageDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const makensis = await findMakensis();
run(makensis, [
  "/INPUTCHARSET", "UTF8",
  `/DVERSION=${version}`,
  `/DSTAGE_DIR=${stageDir}`,
  `/DOUTPUT_DIR=${outputDir}`,
  path.join(root, "installer", "web-installer.nsi"),
]);

const installerName = `团队每日工作台-Web版-Setup-${version}.exe`;
const installerPath = path.join(outputDir, installerName);
const digest = createHash("sha256").update(await readFile(installerPath)).digest("hex");
await writeFile(path.join(outputDir, `${installerName}.sha256`), `${digest}  ${installerName}\n`, "utf8");
await writeFile(path.join(outputDir, `更新说明-${version}.txt`), [
  `团队每日工作台 ${version}`,
  "",
  "安装：双击 Setup.exe，可选择 D 盘或其他本机 NTFS 目录。",
  "升级：直接运行新版安装包，配置和数据会自动备份并保留。",
  "启动：双击桌面“团队每日工作台”，后台服务会静默启动并打开浏览器。",
  "注意：安装包暂未签名，Windows 可能显示未知发布者提示。",
  "",
].join("\r\n"), "utf8");

console.log(`[web-installer] created ${installerPath}`);
console.log(`[web-installer] sha256 ${digest}`);
