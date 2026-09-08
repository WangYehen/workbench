@echo off
REM ============================================================
REM  个人AI工作台 - Windows 一键打包脚本
REM  用法：在项目根目录双击本文件，或在终端执行  build-exe.cmd
REM  产物：release\个人AI工作台 Setup 0.1.0.exe  （NSIS 安装包）
REM ============================================================
setlocal
cd /d "%~dp0"

echo.
echo [1/4] 释放端口 8787 / 5174（若被 dev 服务占用，会锁住原生模块导致打包失败）...
for %%p in (8787 5174) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p " ^| findstr LISTENING') do (
    echo       关闭占用 %%p 端口的进程 PID=%%a
    taskkill /PID %%a /F >nul 2>&1
  )
)

echo.
echo [2/4] 重编译 better-sqlite3 为 Electron ABI ...
call npx @electron/rebuild -f -w better-sqlite3
if errorlevel 1 goto :err

echo.
echo [3/4] electron-builder 打包（前端构建 + 复制依赖 + 生成 NSIS 安装包）...
call npm run build
if errorlevel 1 goto :err
call npx electron-builder --config.npmRebuild=false
if errorlevel 1 goto :err

echo.
echo [4/4] 还原 better-sqlite3 为 Node ABI（恢复本地 dev 环境）...
call npm rebuild better-sqlite3
if errorlevel 1 goto :err

echo.
echo ============================================================
echo  打包完成！
echo  安装包：release\个人AI工作台 Setup 0.1.0.exe
echo  解包版：release\win-unpacked\个人AI工作台.exe
echo ============================================================
goto :eof

:err
echo.
echo [X] 打包失败，请把上方红色错误信息发给开发排查。
exit /b 1
