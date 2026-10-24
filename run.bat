@echo off
REM AquaNexus - starts backend + website on http://localhost:8000
cd /d "%~dp0backend"
if not exist .venv\Scripts\python.exe (
  echo Creating virtual environment...
  python -m venv .venv || goto :error
)
call .venv\Scripts\activate.bat
echo Installing requirements (first run can take a few minutes)...
python -m pip install -q -r requirements.txt || goto :error
echo.
echo ===== AquaNexus running at http://localhost:8000  (Ctrl+C to stop) =====
python -m uvicorn app:app --port 8000
goto :eof
:error
echo.
echo Something went wrong - see the message above.
pause
