@echo off
setlocal EnableExtensions
chcp 65001 >nul
title LinkConsole 构建与运行

rem ============================================================
rem  LinkConsole — 自动打包并运行 (Rust + Tauri 2)
rem  用法:
rem    build-and-run.bat          构建发布版并启动 exe
rem    build-and-run.bat dev      开发模式（热重载，调试用）
rem    build-and-run.bat run      不重新构建，直接运行已构建的 exe
rem    build-and-run.bat clean    清理构建产物
rem ============================================================

set "ROOT=%~dp0"
cd /d "%ROOT%"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=build"

echo.
echo  ============================================
echo    LinkConsole  build-and-run  [%MODE%]
echo  ============================================
echo.

rem ---------- 环境检查 ----------
where node >nul 2>nul || (echo [错误] 未检测到 Node.js，请先安装 Node.js 18+ & goto :fail)
where cargo >nul 2>nul || (echo [错误] 未检测到 Rust/cargo，请先安装 rustup（MSVC 工具链） & goto :fail)
where npm  >nul 2>nul || (echo [错误] 未检测到 npm & goto :fail)

for /f "delims=" %%v in ('node --version') do set "NODE_VER=%%v"
for /f "delims=" %%v in ('cargo --version') do set "CARGO_VER=%%v"
echo  [环境] Node %NODE_VER% ^| %CARGO_VER%
echo.

if /i "%MODE%"=="clean" goto :clean
if /i "%MODE%"=="run"   goto :run
if /i "%MODE%"=="dev"   goto :dev
goto :build

:build
rem ---------- 1. 生成图标（如缺失） ----------
if not exist "src-tauri\icons\icon.ico" (
  echo  [1/4] 生成应用图标...
  call node tools\gen-icons.js || goto :fail
) else (
  echo  [1/4] 应用图标已就绪
)

rem ---------- 2. 安装前端依赖 ----------
if not exist "node_modules" (
  echo  [2/4] 安装前端依赖（首次较慢）...
  call npm install || goto :fail
) else (
  echo  [2/4] 前端依赖已就绪
)

rem ---------- 3. 打包（前端 + Rust，生成 exe 与安装包） ----------
echo  [3/4] 正在打包（首次编译 Rust 依赖约需数分钟，请耐心等待）...
call npm run tauri build
if errorlevel 1 goto :fail

set "EXE=%ROOT%src-tauri\target\release\linkconsole.exe"
if not exist "%EXE%" (
  echo  [错误] 未找到产物 %EXE%
  goto :fail
)

echo  [4/4] 构建完成：
echo         程序:  src-tauri\target\release\linkconsole.exe
for %%f in ("%EXE%") do echo         大小:  %%~zf bytes
if exist "%ROOT%src-tauri\target\release\bundle\nsis\" (
  echo         安装包: src-tauri\target\release\bundle\nsis\*.exe
)

:run
if not exist "%ROOT%src-tauri\target\release\linkconsole.exe" (
  echo  [错误] 尚未构建，请先运行 build-and-run.bat
  goto :fail
)
echo.
echo  正在启动 LinkConsole ...
start "" "%ROOT%src-tauri\target\release\linkconsole.exe"
echo  已启动。可关闭本窗口（程序独立运行）。
exit /b 0

:dev
echo  以开发模式启动（Vite 热重载 + Tauri 窗口，Ctrl+C 退出）...
call npm run tauri dev
exit /b %errorlevel%

:clean
echo  清理构建产物...
if exist "dist" rmdir /s /q "dist"
if exist "src-tauri\target" rmdir /s /q "src-tauri\target"
echo  已清理。
exit /b 0

:fail
echo.
echo  ================= 构建失败 =================
echo  请检查上方错误信息。常见原因：
echo   - 未安装 Visual Studio C++ 生成工具（MSVC）
echo   - 未安装 Rust（rustup，选择 windows-msvc 工具链）
echo   - 未安装 Node.js 18+
echo  ============================================
exit /b 1
