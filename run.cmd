@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

:: ============================================================
::  团队每日工作台 - 本地一键启动脚本
::  启动后：前端 http://localhost:5174  后端 http://localhost:8787
::  关闭：按 Ctrl + C
:: ============================================================

:: 关键修复：WorkBuddy 桌面进程会向环境注入
::   NODE_OPTIONS=--use-system-ca ...
:: 而 Node.js 拒绝在 NODE_OPTIONS 里使用 --use-system-ca，导致 node 启动即报错，
:: 连带 vite 被 concurrently -k 一起杀掉，页面永远打不开。此处先清空它。
set "NODE_OPTIONS="

:: 切换到脚本所在目录（无论从哪里双击都能正确定位项目）
cd /d "%~dp0"

:: ---------- 环境检查 ----------
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 18+ 后重试。
    echo 下载地址：https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=1" %%v in ('node -v') do set NODE_VER=%%v
echo [环境] 检测到 Node.js %NODE_VER%

:: ---------- 依赖检查 ----------
if not exist "node_modules" (
    echo [依赖] 未找到 node_modules，正在执行 npm install ...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络或 npm 配置。
        pause
        exit /b 1
    )
) else (
    echo [依赖] node_modules 已存在，跳过安装。
)

:: ---------- 启动服务 ----------
echo.
echo [启动] 正在启动前端(5174) + 后端(8787) ...
echo [提示] 启动完成请访问 http://localhost:5174
echo [提示] 按 Ctrl + C 停止所有服务。
echo.

:: 延迟 4 秒后自动打开浏览器（不需要可删掉下面这行）
start "" cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:5174"

:: npm run dev 内部用 concurrently 同时拉起 server + vite，-k 保证 Ctrl+C 时一并结束
call npm run dev

:: 脚本随服务进程结束而退出
endlocal
