@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.." >nul 2>nul || (
  echo error: Could not resolve repository root from %SCRIPT_DIR% >&2
  exit /b 1
)
set "REPO_ROOT=%CD%"
popd >nul

if not defined PI_BIN set "PI_BIN=pi"
if defined PI_CODING_AGENT_DIR (
  set "AGENT_DIR=%PI_CODING_AGENT_DIR%"
) else (
  set "AGENT_DIR=%USERPROFILE%\.pi\agent"
)
if defined PI_WORKFLOW_SOURCE_DIR (
  set "SOURCE_DIR=%PI_WORKFLOW_SOURCE_DIR%"
) else (
  set "SOURCE_DIR=%REPO_ROOT%\pi-workflow"
)
if not defined PI_WORKFLOW_CURSOR_PACKAGE set "PI_WORKFLOW_CURSOR_PACKAGE=npm:@rahularya01/pi-cursor"
if not defined PI_AGY_BIN set "PI_AGY_BIN=agy"

set "SKIP_CURSOR=0"
set "DRY_RUN=0"

if "%~1"=="-h" goto show_help
if "%~1"=="--help" goto show_help

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--dry-run" set "DRY_RUN=1" & shift & goto parse_args
if /i "%~1"=="--skip-cursor" set "SKIP_CURSOR=1" & shift & goto parse_args
if /i "%~1"=="--agent-dir" (
  if "%~2"=="" goto bad_arg
  set "AGENT_DIR=%~2"
  shift
  shift
  goto parse_args
)
if /i "%~1"=="--source-dir" (
  if "%~2"=="" goto bad_arg
  set "SOURCE_DIR=%~2"
  shift
  shift
  goto parse_args
)
if /i "%~1"=="--source" (
  if "%~2"=="" goto bad_arg
  set "SOURCE_DIR=%~2"
  shift
  shift
  goto parse_args
)
goto unknown_arg

:args_done
if "%PI_WORKFLOW_SKIP_CURSOR%"=="1" set "SKIP_CURSOR=1"

if not exist "%SOURCE_DIR%\index.ts" (
  echo error: Extension entrypoint not found: %SOURCE_DIR%\index.ts >&2
  exit /b 1
)

set "TARGET_DIR=%AGENT_DIR%\extensions\pi-three-lane-workflow"

if "%DRY_RUN%"=="1" (
  echo source: %SOURCE_DIR%
  echo target: %TARGET_DIR%
  if "%SKIP_CURSOR%"=="1" (
    echo Cursor provider installation: skipped
  ) else (
    echo Cursor provider: %PI_WORKFLOW_CURSOR_PACKAGE%
  )
  echo AGY executable expected by the extension: %PI_AGY_BIN%
  exit /b 0
)

where %PI_BIN% >nul 2>nul
if errorlevel 1 (
  echo error: Pi executable not found: %PI_BIN%. Install Pi or set PI_BIN. >&2
  exit /b 1
)

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"

set "FILE_COUNT=0"
for %%f in ("%SOURCE_DIR%\*.ts") do set /a FILE_COUNT+=1
if !FILE_COUNT! LEQ 0 (
  echo error: No .ts files found in %SOURCE_DIR% >&2
  exit /b 1
)

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMddTHHmmssfffZ"') do set "STAMP=%%i"

for %%f in ("%SOURCE_DIR%\*.ts") do (
  set "BASE=%%~nxf"
  set "TARGET=%TARGET_DIR%\!BASE!"
  if exist "!TARGET!" (
    fc /b "%%f" "!TARGET!" >nul 2>nul
    if errorlevel 1 (
      copy /Y "!TARGET!" "!TARGET!.bak.!STAMP!" >nul
      echo Backed up !BASE! to !BASE!.bak.!STAMP!
    )
  )
  copy /Y "%%f" "!TARGET!" >nul
  echo Installed !BASE!
)

if "%SKIP_CURSOR%"=="1" (
  echo Skipped Cursor provider installation
) else (
  echo Installing Cursor provider: %PI_WORKFLOW_CURSOR_PACKAGE%
  set "PI_CODING_AGENT_DIR=%AGENT_DIR%"
  %PI_BIN% install %PI_WORKFLOW_CURSOR_PACKAGE%
  if errorlevel 1 exit /b %ERRORLEVEL%
)

where %PI_AGY_BIN% >nul 2>nul
if errorlevel 1 (
  echo warning: AGY executable not found: %PI_AGY_BIN%. Set PI_AGY_BIN before using mode=agy. >&2
) else (
  echo AGY executable found: %PI_AGY_BIN%
)

echo.
echo Pi workflow installation complete.
echo Agent directory: %AGENT_DIR%
echo Extension:       %TARGET_DIR%
echo.
echo Restart Pi or run /reload, then use:
echo   /workflow plan ^<task^>
echo   /workflow review ^<task^>
echo   /workflow agy ^<task^>
echo   /workflow-status
exit /b 0

:show_help
echo Install the Pi three-lane workflow extension for Windows.
echo.
echo Usage:
echo   scripts\install-pi-workflow.cmd [options]
echo.
echo Options:
echo   --agent-dir PATH     Pi agent directory (default: %%PI_CODING_AGENT_DIR%% or %%USERPROFILE%%\.pi\agent)
echo   --source-dir PATH    Extension source directory (default: this repo's pi-workflow\)
echo   --skip-cursor        Do not install the Cursor provider package
echo   --dry-run            Show the installation plan without changing files
echo   -h, --help           Show this help
echo.
echo Environment:
echo   PI_BIN                      Pi executable (default: pi)
echo   PI_CODING_AGENT_DIR         Pi agent directory
echo   PI_WORKFLOW_SOURCE_DIR      Extension source directory override
echo   PI_WORKFLOW_CURSOR_PACKAGE  Cursor provider package (default: npm:@rahularya01/pi-cursor)
echo   PI_AGY_BIN                  AGY executable used by the extension (default: agy)
echo   PI_WORKFLOW_SKIP_CURSOR=1   Same as --skip-cursor
exit /b 0

:bad_arg
echo error: Missing value for %~1 >&2
exit /b 1

:unknown_arg
echo error: Unknown option: %~1 (use --help) >&2
exit /b 1
