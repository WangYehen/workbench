// 最小化 preload：仅暴露安全的版本信息，不泄露任何凭据或 Node API
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("workbench", {
  version: "0.1.0",
  platform: process.platform,
});
