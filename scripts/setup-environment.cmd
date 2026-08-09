@echo off
setlocal

if defined MODEL_FUSION_PYTHON (
  if exist "%MODEL_FUSION_PYTHON%" (
    "%MODEL_FUSION_PYTHON%" "%~dp0setup_environment.py" %*
    exit /b %ERRORLEVEL%
  )
)

where py >nul 2>nul
if not errorlevel 1 (
  py -3 "%~dp0setup_environment.py" %*
  exit /b %ERRORLEVEL%
)

where python >nul 2>nul
if not errorlevel 1 (
  python --version >nul 2>nul
  if not errorlevel 1 (
    python "%~dp0setup_environment.py" %*
    exit /b %ERRORLEVEL%
  )
)

>&2 echo Python 3 was not found. Install Python or run setup_environment.py with an explicit Python executable.
>&2 echo You can also set MODEL_FUSION_PYTHON to the full path of a Python 3 executable.
exit /b 1
