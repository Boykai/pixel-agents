@echo off
setlocal
if defined PIXEL_AGENTS_NODE_BIN (
  "%PIXEL_AGENTS_NODE_BIN%" "%~dp0mock-copilot-runner.cjs" %*
) else (
  node "%~dp0mock-copilot-runner.cjs" %*
)
