@echo off
setlocal
cd /d "%~dp0"
set "PY="
rem The py launcher works even when PATH is incomplete, so try it first.
for %%V in (3.13 3.12 3.11 3.14) do if not defined PY py -%%V -c "import sys" >nul 2>nul && set "PY=%%V"
if defined PY (
    rem pyw runs without a console window; start returns at once and this window closes.
    start "" pyw -%PY% -m agent_city --data-dir "%~dp0.local" --open %*
    exit /b 0
)
python -c "import sys; sys.exit(sys.version_info < (3, 11))" >nul 2>nul
if not errorlevel 1 (
    start "" pythonw -m agent_city --data-dir "%~dp0.local" --open %*
    exit /b 0
)
echo No se encontro Python 3.11 o posterior.
echo Instalalo desde https://www.python.org/downloads/ y vuelve a abrir este archivo.
pause
exit /b 1
