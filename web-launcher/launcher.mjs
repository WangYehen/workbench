import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const installRoot = path.resolve(__dirname, "..");
const currentPath = path.join(installRoot, "current.json");
const dataDir = path.join(installRoot, "data");
const configDir = path.join(installRoot, "config");
const logsDir = path.join(installRoot, "logs");
const backupsDir = path.join(installRoot, "backups");
const pidPath = path.join(dataDir, "server.pid.json");
const startLockPath = path.join(dataDir, "server.start.lock");
const servicePort = Number(process.env.WORKBENCH_PORT || 8787);
if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65535) throw new Error("WORKBENCH_PORT 端口配置无效。");
const healthUrl = `http://127.0.0.1:${servicePort}/api/health`;
const appUrl = `http://127.0.0.1:${servicePort}`;
const quiet = process.argv.includes("--quiet");

function inside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

async function ensureLayout() {
  await Promise.all([dataDir, configDir, logsDir, backupsDir].map((dir) => mkdir(dir, { recursive: true })));
}

async function readJson(target, fallback = null) {
  try { return JSON.parse(await readFile(target, "utf8")); } catch { return fallback; }
}

async function writeJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function currentVersion() {
  const current = await readJson(currentPath);
  if (!current?.version || !/^[0-9A-Za-z._-]+$/.test(current.version)) {
    throw new Error("没有找到可启动的工作台版本，请重新运行安装包。");
  }
  const versionDir = path.join(installRoot, "versions", current.version);
  if (!(await exists(versionDir))) throw new Error(`程序版本 ${current.version} 不完整，请重新运行安装包。`);
  return { ...current, versionDir };
}

async function health(timeoutMs = 1_500) {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (!response.ok) return { occupied: true, httpStatus: response.status };
    try { return { occupied: true, ...await response.json() }; }
    catch { return { occupied: true, httpStatus: response.status }; }
  } catch { return null; }
}

function openTarget(target) {
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", target], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function showError(error) {
  await ensureLayout();
  const message = error?.message || String(error);
  const target = path.join(logsDir, "last-launch-error.txt");
  await writeFile(target, message, "utf8");
  if (quiet) return;
  const child = spawn("wscript.exe", [path.join(__dirname, "message.vbs"), target, "个人AI工作台"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function waitForHealth(instanceId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await health(800);
    if (info?.service === "personal-ai-workbench" && (!instanceId || info.instanceId === instanceId)) return info;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

async function startServer({ openBrowser = true } = {}) {
  await ensureLayout();
  const running = await health();
  if (running) {
    if (running.service !== "personal-ai-workbench") throw new Error(`端口 ${servicePort} 已被其他程序占用，请关闭占用程序后重试。`);
    if (openBrowser) openTarget(appUrl);
    return running;
  }

  let lockFd;
  try {
    lockFd = fs.openSync(startLockPath, "wx");
    fs.writeFileSync(lockFd, `${process.pid}\n`, "utf8");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const starting = await waitForHealth(null, 20_000);
    if (starting?.service === "personal-ai-workbench") {
      if (openBrowser) openTarget(appUrl);
      return starting;
    }
    await rm(startLockPath, { force: true });
    throw new Error("工作台启动锁已失效，请重新双击桌面快捷方式。");
  }

  try {
    const current = await currentVersion();
    const nodeExe = path.join(current.versionDir, "runtime", "node.exe");
    const appDir = path.join(current.versionDir, "app");
    const serverEntry = path.join(appDir, "server", "index.mjs");
    if (!(await exists(nodeExe)) || !(await exists(serverEntry))) throw new Error("工作台运行文件不完整，请重新运行安装包。");

    const instanceId = randomUUID();
    const logPath = path.join(logsDir, `server-${new Date().toISOString().slice(0, 10)}.log`);
    const logFd = fs.openSync(logPath, "a");
    const child = spawn(nodeExe, [serverEntry], {
      cwd: appDir,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: String(servicePort),
        PUBLIC_BASE_URL: appUrl,
        CORS_ORIGIN: appUrl,
        USE_DEMO_DATA: process.env.USE_DEMO_DATA || "false",
        WORKBENCH_APP_VERSION: current.version,
        WORKBENCH_RUNTIME_MODE: "web-installer",
        WORKBENCH_INSTALL_ROOT: installRoot,
        WORKBENCH_CONFIG_PATH: path.join(configDir, "app.env"),
        WORKBENCH_DATA_DIR: dataDir,
        WORKBENCH_INSTANCE_ID: instanceId,
      },
    });
    fs.closeSync(logFd);
    child.unref();
    await writeJsonAtomic(pidPath, { pid: child.pid, instanceId, version: current.version, startedAt: new Date().toISOString() });

    const info = await waitForHealth(instanceId);
    if (!info) {
      try { process.kill(child.pid); } catch { /* 进程可能已经自行退出。 */ }
      throw new Error(`工作台服务未能启动，请把日志文件发给开发排查：${logPath}`);
    }
    if (openBrowser) openTarget(appUrl);
    return info;
  } finally {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    await rm(startLockPath, { force: true });
  }
}

async function stopServer() {
  const info = await health();
  const pidState = await readJson(pidPath);
  if (!info) {
    await rm(pidPath, { force: true });
    return false;
  }
  if (info.service !== "personal-ai-workbench") throw new Error(`端口 ${servicePort} 由其他程序占用，工作台不会结束该进程。`);
  if (!pidState?.pid || pidState.instanceId !== info.instanceId) {
    throw new Error("无法确认后台服务的进程身份，请注销 Windows 后再执行升级。 ");
  }
  const result = spawnSync("taskkill.exe", ["/PID", String(pidState.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && await health(400)) await new Promise((resolve) => setTimeout(resolve, 250));
  if (await health(400)) {
    if (result.status !== 0) throw new Error("无法停止工作台后台服务，请在任务管理器结束 node.exe 后重试。");
    throw new Error("工作台后台服务未在 10 秒内停止，请稍后重试。");
  }
  await rm(pidPath, { force: true });
  return true;
}

async function resetDirectory(target) {
  if (!inside(installRoot, target)) throw new Error(`拒绝清理安装目录之外的路径：${target}`);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}

async function copyIfPresent(source, target) {
  if (await exists(source)) await cp(source, target, { recursive: true, force: true });
}

async function createRollbackBackup() {
  await ensureLayout();
  const target = path.join(backupsDir, "rollback");
  await resetDirectory(target);
  await copyIfPresent(configDir, path.join(target, "config"));
  await copyIfPresent(dataDir, path.join(target, "data"));
  await writeFile(path.join(target, "created-at.txt"), new Date().toISOString(), "utf8");
  return target;
}

async function restoreRollbackBackup() {
  const source = path.join(backupsDir, "rollback");
  if (!(await exists(source))) throw new Error("没有找到升级前备份，无法自动恢复。");
  await resetDirectory(configDir);
  await resetDirectory(dataDir);
  await copyIfPresent(path.join(source, "config"), configDir);
  await copyIfPresent(path.join(source, "data"), dataDir);
}

async function activate(version) {
  if (!version || !/^[0-9A-Za-z._-]+$/.test(version)) throw new Error("待启用版本号无效。");
  const versionDir = path.join(installRoot, "versions", version);
  if (!(await exists(versionDir))) throw new Error(`待启用版本 ${version} 不存在。`);
  const current = await readJson(currentPath, {});
  const previousVersion = current.version && current.version !== version ? current.version : current.previousVersion || null;
  await writeJsonAtomic(currentPath, { version, previousVersion, activatedAt: new Date().toISOString() });
}

async function rollbackVersion() {
  await stopServer().catch(() => false);
  const current = await readJson(currentPath);
  if (!current?.previousVersion) throw new Error("没有可回退的上一版本。");
  await restoreRollbackBackup();
  await writeJsonAtomic(currentPath, {
    version: current.previousVersion,
    previousVersion: current.version,
    activatedAt: new Date().toISOString(),
    rolledBackAt: new Date().toISOString(),
  });
  await startServer({ openBrowser: false });
}

async function manualBackup() {
  const wasRunning = Boolean(await health());
  if (wasRunning) await stopServer();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(backupsDir, `manual-${stamp}`);
  await mkdir(target, { recursive: true });
  await copyIfPresent(configDir, path.join(target, "config"));
  await copyIfPresent(dataDir, path.join(target, "data"));
  if (wasRunning) await startServer({ openBrowser: false });
  openTarget(target);
  return target;
}

function hardenDirectory(target) {
  // Keep inherited ACLs from the selected directory. Replacing them can
  // lock out localized/domain accounts during an upgrade.
  fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
}

async function prepareInstall() {
  await ensureLayout();
  hardenDirectory(configDir);
  hardenDirectory(dataDir);
  hardenDirectory(backupsDir);
}

async function main() {
  const [command = "start", value] = process.argv.slice(2).filter((arg) => arg !== "--quiet");
  if (command === "start") await startServer({ openBrowser: true });
  else if (command === "verify") await startServer({ openBrowser: false });
  else if (command === "stop") await stopServer();
  else if (command === "restart") { await stopServer().catch(() => false); await startServer({ openBrowser: true }); }
  else if (command === "backup-rollback") await createRollbackBackup();
  else if (command === "restore-rollback") await restoreRollbackBackup();
  else if (command === "activate") await activate(value);
  else if (command === "rollback") await rollbackVersion();
  else if (command === "backup") await manualBackup();
  else if (command === "prepare-install") await prepareInstall();
  else throw new Error(`未知启动器命令：${command}`);
}

main().catch(async (error) => {
  await showError(error).catch(() => {});
  process.exitCode = 1;
});
