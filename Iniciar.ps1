param(
    [ValidateRange(1024, 65535)][int]$Port = 4317,
    [string]$DataDir = ''
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not $DataDir) {
    $DataDir = Join-Path $PSScriptRoot '.local'
}

# The py launcher works even when PATH is incomplete, so try it first.
function Find-Python {
    $ErrorActionPreference = 'Continue'
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        foreach ($version in '3.13', '3.12', '3.11', '3.14') {
            & $py.Source "-$version" -c 'import sys' 2>$null
            if ($LASTEXITCODE -eq 0) { return @{ Exe = $py.Source; Args = @("-$version") } }
        }
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        & $python.Source -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>$null
        if ($LASTEXITCODE -eq 0) { return @{ Exe = $python.Source; Args = @() } }
    }
    return $null
}

$found = Find-Python
if (-not $found) {
    Write-Error 'No se encontro Python 3.11 o posterior. Instalalo desde https://www.python.org/downloads/'
    exit 1
}
# Windowless start: pyw/pythonw have no console, and this script returns at once.
$windowless = Join-Path (Split-Path $found.Exe) $(if ($found.Args.Count) { 'pyw.exe' } else { 'pythonw.exe' })
if (-not (Test-Path -LiteralPath $windowless)) { $windowless = $found.Exe }
Start-Process -FilePath $windowless -ArgumentList (@($found.Args) + @('-m', 'agent_city', '--port', $Port, '--data-dir', "`"$DataDir`"", '--open')) -WindowStyle Hidden
