[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$runRoot = Join-Path $projectRoot "work\run"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$processorScript = Join-Path $projectRoot "local-processor\server.mjs"
$webCli = Join-Path $projectRoot "node_modules\vinext\dist\cli.js"
$configuredWebPort = $env:LOCAL_WEB_PORT
if (-not $configuredWebPort) {
  $envPath = Join-Path $projectRoot ".env"
  if (Test-Path -LiteralPath $envPath) {
    $portLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^\s*LOCAL_WEB_PORT\s*=' } | Select-Object -First 1
    if ($portLine) { $configuredWebPort = ($portLine -split '=', 2)[1].Trim().Trim('"').Trim("'") }
  }
}
if (-not $configuredWebPort) { $configuredWebPort = "3002" }
if ($configuredWebPort -notmatch '^\d+$' -or [double]$configuredWebPort -lt 1 -or [double]$configuredWebPort -gt 65535) {
  throw "LOCAL_WEB_PORT must be an integer between 1 and 65535."
}
$webPort = [int]$configuredWebPort
# Keep the processor's allowed origin consistent with this launcher's override.
$env:LOCAL_WEB_PORT = "$webPort"
$webUrl = "http://127.0.0.1:$webPort"
$pidPath = Join-Path $runRoot "processes.json"
$quote = [char]34
$processorArgument = "$quote$processorScript$quote"
$webArgument = "$quote$webCli$quote"

& (Join-Path $PSScriptRoot "verify-setup.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "Local runtime verification failed. Run npm run setup first."
}

New-Item -ItemType Directory -Force -Path $runRoot | Out-Null

function Test-Processor {
  try {
    return [bool](Invoke-RestMethod -Uri "http://127.0.0.1:8787/health" -TimeoutSec 2).ok
  } catch {
    return $false
  }
}

function Test-Web {
  try {
    $response = Invoke-WebRequest -Uri "$webUrl/" -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -eq 200 -and $response.Content -match "Touchline AI"
  } catch {
    return $false
  }
}

$processorProcess = $null
$webProcess = $null
$webReady = Test-Web
if (-not $webReady -and (Get-NetTCPConnection -State Listen -LocalPort $webPort -ErrorAction SilentlyContinue)) {
  throw "Port $webPort is occupied by another application. No processes were stopped. Set LOCAL_WEB_PORT to a free port in .env."
}
if (-not (Test-Processor)) {
  $processorProcess = Start-Process -FilePath $node -ArgumentList @($processorArgument) -WorkingDirectory $projectRoot -RedirectStandardOutput (Join-Path $runRoot "processor.out.log") -RedirectStandardError (Join-Path $runRoot "processor.err.log") -WindowStyle Hidden -PassThru
}
if (-not $webReady) {
  $webProcess = Start-Process -FilePath $node -ArgumentList @($webArgument, "dev", "--port", "$webPort", "--hostname", "127.0.0.1") -WorkingDirectory $projectRoot -RedirectStandardOutput (Join-Path $runRoot "web.out.log") -RedirectStandardError (Join-Path $runRoot "web.err.log") -WindowStyle Hidden -PassThru
}

@{
  processorPid = if ($processorProcess) { $processorProcess.Id } else { $null }
  webPid = if ($webProcess) { $webProcess.Id } else { $null }
  startedAt = (Get-Date).ToString("o")
} | ConvertTo-Json | Set-Content -LiteralPath $pidPath -Encoding UTF8

$deadline = (Get-Date).AddSeconds(120)
do {
  $processorReady = Test-Processor
  $webReady = Test-Web
  if ($processorReady -and $webReady) { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

if (-not $processorReady -or -not $webReady) {
  Write-Output "Startup did not complete. Review logs under $runRoot"
  if (Test-Path -LiteralPath (Join-Path $runRoot "processor.err.log")) {
    Get-Content -LiteralPath (Join-Path $runRoot "processor.err.log") -Tail 20
  }
  if (Test-Path -LiteralPath (Join-Path $runRoot "web.err.log")) {
    Get-Content -LiteralPath (Join-Path $runRoot "web.err.log") -Tail 20
  }
  exit 1
}

Write-Output "Touchline AI is running."
Write-Output "Open: $webUrl"
Write-Output "Processor health: http://127.0.0.1:8787/health"
Write-Output "Logs: $runRoot"
Write-Output "Stop both services with: npm run local:stop"
