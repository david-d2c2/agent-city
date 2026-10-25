@echo off
setlocal
cd /d "%~dp0"
set "PY="
for %%V in (3.13 3.12 3.11 3.14) do if not defined PY py -%%V -c "import sys" >nul 2>nul && set "PY=py -%%V"
if not defined PY python -c "import sys; sys.exit(sys.version_info < (3, 11))" >nul 2>nul && set "PY=python"
if not defined PY (
    echo No se encontro Python 3.11 o posterior.
    pause
    exit /b 1
)
%PY% -m agent_city --stop
ping -n 3 127.0.0.1 >nul
