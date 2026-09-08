import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const jsonFromLines = (text) => String(text || "").split(/\r?\n/).reverse().map((line) => { try { return JSON.parse(line); } catch { return null; } }).find(Boolean);
const textFromEvent = (event) => event?.text || event?.content || event?.message?.content || event?.part?.text || event?.data?.text || "";

export function createOpenCodeAdapter({ executable = "opencode", cwd = process.cwd(), timeoutMs = 45_000, model = "opencode/big-pickle", enabled = true } = {}) {
  function command() {
    if (process.platform !== "win32") return { file: executable, prefix: [] };
    let resolved = executable;
    if (!/[\\/]\.|\.ps1$|\.cmd$|\.exe$/i.test(resolved)) {
      const probe = spawnSync("where.exe", [resolved], { encoding: "utf8", windowsHide: true });
      resolved = String(probe.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || resolved;
    }
    if (process.platform === "win32" && !/\.(ps1|cmd|exe)$/i.test(resolved)) {
      const bundled = path.join(path.dirname(resolved), "node_modules", "opencode-ai", "bin", "opencode.exe");
      if (fs.existsSync(bundled)) resolved = bundled;
    }
    if (/\.ps1$/i.test(resolved)) return { file: "powershell.exe", prefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved], powershell: true };
    return { file: resolved, prefix: [], powershell: false };
  }
  async function run(prompt) {
    if (!enabled) throw Object.assign(new Error("OpenCode Adapter 未启用"), { code: "OPENCODE_DISABLED" });
    return new Promise((resolve, reject) => {
      const launcher = command();
      const args = ["run", "--format", "json", "--model", model, "--dir", cwd, prompt];
      // Windows 的 OpenCode 可执行文件在非 TTY 的 Node 子进程中可能等待输入；
      // 通过 PowerShell 包装启动，并把 prompt 放入环境变量，避免 shell 拼接用户文本。
      let child;
      if (process.platform === "win32") {
        const quote = (value) => String(value).replace(/'/g, "''");
        const target = launcher.powershell ? launcher.prefix[4] : launcher.file;
        const command = `& '${quote(target)}' run --format json --model '${quote(model)}' --dir '${quote(cwd)}' $env:WORKBENCH_OPENCODE_PROMPT`;
        child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WORKBENCH_OPENCODE_PROMPT: prompt } });
      } else {
        child = spawn(launcher.file, [...launcher.prefix, ...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      }
      let stdout = ""; let stderr = ""; const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error("OpenCode 响应超时"), { code: "OPENCODE_TIMEOUT" })); }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(Object.assign(new Error(`OpenCode 不可用：${error.message}`), { code: "OPENCODE_UNAVAILABLE" })); });
      child.on("close", (code) => { clearTimeout(timer); if (code !== 0) return reject(Object.assign(new Error(stderr.trim().slice(0, 240) || "OpenCode 执行失败"), { code: "OPENCODE_FAILED" })); resolve(stdout); });
    });
  }
  async function request(prompt) {
    const raw = await run(prompt); const events = raw.split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const text = events.map(textFromEvent).filter(Boolean).join("") || textFromEvent(jsonFromLines(raw));
    if (!text) throw Object.assign(new Error("OpenCode 未返回文本结果"), { code: "OPENCODE_EMPTY" });
    return text;
  }
  async function agentPlan({ messages = [], tools = [], userText = "" }) {
    const text = await request(`你是工作台 Agent。仅使用给定工具，先读取数据。严格只输出 JSON，不要 Markdown：{\"kind\":\"final|tool_call|structured_write|confirmation\",\"tool\":string|null,\"arguments\":{},\"answer\":string,\"reason\":string,\"result_schema\":string|null}。可用工具：${JSON.stringify(tools)}。上下文：${JSON.stringify(messages)}。用户请求：${userText}`);
    const parsed = jsonFromLines(text) || JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "null");
    if (!parsed?.kind) throw Object.assign(new Error("OpenCode 返回的计划格式无效"), { code: "OPENCODE_INVALID_PLAN" });
    return parsed;
  }
  async function agentAnswer({ messages = [], context = "" }) {
    const text = await request(`根据真实工具结果，用简体中文简洁回答主管。不要编造事实。上下文：${JSON.stringify(messages)}。工具结果：${context}`);
    return { answer: text };
  }
  return { agentPlan, agentAnswer };
}
