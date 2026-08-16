import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.API_TARGET || "http://127.0.0.1:8787";
// 前端端口：与 GitHub 仓库 WangYehen/my-work-bench 对齐，默认 5174，可用 WORKBENCH_PORT 覆盖
const FRONTEND_PORT = Number(process.env.WORKBENCH_PORT || 5174);

export default defineConfig({
  plugins: [react()],
  root: ".",
  server: {
    host: "127.0.0.1",
    port: FRONTEND_PORT,
    strictPort: false,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/oauth": { target: API_TARGET, changeOrigin: true },
      "/auth": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
