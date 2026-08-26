@echo off
REM ============================================================
REM  Tagda Timer
REM  Double-click this file. Your browser opens automatically.
REM  Close this window to stop the timer.
REM
REM  The timer must be SERVED, not opened straight off disk --
REM  browsers block JavaScript modules on file:// addresses, so
REM  double-clicking index.html gives a dead page.
REM ============================================================

setlocal
cd /d "%~dp0"

set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set PY="%LOCALAPPDATA%\Programs\Python\Python313\python.exe"

if not defined PY (
  echo.
  echo   Could not find Python on this machine.
  echo   Install it from https://python.org  ^(tick "Add to PATH"^)
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

%PY% serve.py 5173
if errorlevel 1 pause
