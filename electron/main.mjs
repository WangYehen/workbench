import { app, BrowserWindow } from "electron";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const isProd = process.env.NODE_ENV === "production";
const SERVER_URL = isProd ? "http://127.0.0.1:8787" : "http://127.0.0.1:5174";

let serverProc = null;

function startServer() {
  if (isProd) {
    serverProc = spawn(process.execPath, ["server/index.mjs"], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: "ignore",
    });
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.mjs"),
    },
  });
  win.loadURL(SERVER_URL);
}

app.whenReady().then(() => {
  startServer();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  if (serverProc) serverProc.kill();
  if (process.platform !== "darwin") app.quit();
});
