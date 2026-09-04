@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
set "PROJECT_PYTHON=%PROJECT_DIR%\.venv\Scripts\python.exe"
set "PREPROCESS_SCRIPT=%SCRIPT_DIR%third_preprocess.py"

if exist "%PROJECT_PYTHON%" goto :confirm
echo ERROR: Preprocessing Python environment was not found.
echo Create .venv in the preprocessing folder and install requirements.txt first.
goto :finish

:confirm
set "RUN_CONFIRM="
set /p "RUN_CONFIRM=Run third preprocessing and replace its current outputs? [y/N]: "
if /I "%RUN_CONFIRM%"=="y" goto :run
echo Cancelled. No output was changed.
goto :finish

:run
pushd "%PROJECT_DIR%" >nul
"%PROJECT_PYTHON%" "%PREPROCESS_SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"
popd >nul

echo.
if not "%EXIT_CODE%"=="0" echo The run did not finish. Exit code: %EXIT_CODE%

:finish
echo.
pause
endlocal
