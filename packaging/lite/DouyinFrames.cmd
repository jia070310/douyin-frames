@echo off
setlocal
cd /d "%~dp0"
set DOUYIN_FRAMES_ROOT=%~dp0
set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
set NODE_ENV=production

REM Prefer portable Node, then system Node
set NODE_BIN=
if exist "%~dp0tools\node\node.exe" set NODE_BIN=%~dp0tools\node\node.exe
if not defined NODE_BIN (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [Douyin Frames] 未找到 Node.js。请安装 Node 18+，或把便携 node.exe 放到 tools\node\
    pause
    exit /b 1
  )
  set NODE_BIN=node
)

"%NODE_BIN%" "%~dp0src\desktop.js"
endlocal
