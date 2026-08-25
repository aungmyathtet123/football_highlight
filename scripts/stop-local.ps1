[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$runRoot = Join-Path $projectRoot "work\run"
$pidPath = Join-Path $runRoot "processes.json"

if (-not (Test-Path -LiteralPath $pidPath)) {
  Write-Output "No Touchline AI process record was found."
  exit 0
}

$record = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
$stopped = 0
foreach ($pidValue in @($record.processorPid, $record.webPid)) {
  if (-not $pidValue) { continue }
  $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
  if (-not $process) { continue }
  $details = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$pidValue)" -ErrorAction SilentlyContinue
  $commandLine = if ($details) { [string]$details.CommandLine } else { "" }
  $isTouchlineProcess = $commandLine -match "local-processor[\\/]server\.mjs" -or
    $commandLine -match "vinext[\\/]dist[\\/]cli\.js"
  if (-not $isTouchlineProcess) {
    Write-Warning "PID $pidValue no longer belongs to Touchline AI; it was not stopped."
    continue
  }
  Stop-Process -Id ([int]$pidValue) -Force
  $stopped += 1
}

Remove-Item -LiteralPath $pidPath -Force
if ($stopped -gt 0) {
  Write-Output "Stopped $stopped Touchline AI service process(es)."
} else {
  Write-Output "Touchline AI was already stopped."
}
