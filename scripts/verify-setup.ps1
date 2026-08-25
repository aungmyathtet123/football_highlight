[CmdletBinding()]
param(
  [switch]$RequireCloud
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
$failures = [Collections.Generic.List[string]]::new()

function Read-ProjectEnv {
  $values = @{}
  if (-not (Test-Path -LiteralPath $envPath)) { return $values }
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match "^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$") {
      $values[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
    }
  }
  return $values
}

function Resolve-ProjectPath([string]$value) {
  if ([IO.Path]::IsPathRooted($value)) { return [IO.Path]::GetFullPath($value) }
  return [IO.Path]::GetFullPath((Join-Path $projectRoot $value))
}

function Pass([string]$message) {
  Write-Output "[OK] $message"
}

function Fail([string]$message) {
  $failures.Add($message)
  Write-Output "[MISSING] $message"
}

$values = Read-ProjectEnv
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node) {
  $nodeVersion = (& $node.Source --version).Trim()
  Pass "Node.js $nodeVersion"
} else {
  Fail "Node.js 22.13 or newer is not installed or not on PATH."
}

if (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules")) {
  Pass "Node.js dependencies"
} else {
  Fail "node_modules is missing. Run npm ci."
}

if (Test-Path -LiteralPath $envPath) {
  Pass "Private .env file"
} else {
  Fail ".env is missing. Copy .env.example to .env."
}

$ffmpegSetting = if ($values.ContainsKey("FFMPEG_PATH")) { $values["FFMPEG_PATH"] } else { "./tools/ffmpeg/bin/ffmpeg.exe" }
$ffprobeSetting = if ($values.ContainsKey("FFPROBE_PATH")) { $values["FFPROBE_PATH"] } else { "./tools/ffmpeg/bin/ffprobe.exe" }
$ffmpeg = Resolve-ProjectPath $ffmpegSetting
$ffprobe = Resolve-ProjectPath $ffprobeSetting
if (Test-Path -LiteralPath $ffmpeg) {
  & $ffmpeg -version *> $null
  if ($LASTEXITCODE -eq 0) { Pass "FFmpeg" } else { Fail "FFmpeg exists but could not run." }
} else {
  Fail "FFmpeg is missing at $ffmpeg"
}
if (Test-Path -LiteralPath $ffprobe) {
  & $ffprobe -version *> $null
  if ($LASTEXITCODE -eq 0) { Pass "FFprobe" } else { Fail "FFprobe exists but could not run." }
} else {
  Fail "FFprobe is missing at $ffprobe"
}

$pythonSetting = if ($values.ContainsKey("TRACKING_PYTHON")) { $values["TRACKING_PYTHON"] } else { "./.venv-tracking/Scripts/python.exe" }
$trackingPython = Resolve-ProjectPath $pythonSetting
if (Test-Path -LiteralPath $trackingPython) {
  & $trackingPython -c "import cv2, torch, ultralytics" *> $null
  if ($LASTEXITCODE -eq 0) {
    Pass "Python tracking environment"
  } else {
    Fail "The tracking environment exists but required packages cannot be imported."
  }
} else {
  Fail "Tracking Python is missing at $trackingPython"
}

$modelSetting = if ($values.ContainsKey("TRACKING_MODEL")) { $values["TRACKING_MODEL"] } else { "./tools/tracking/yolo11n.pt" }
$trackingModel = Resolve-ProjectPath $modelSetting
if (Test-Path -LiteralPath $trackingModel) {
  Pass "YOLO tracking model"
} else {
  Fail "YOLO tracking model is missing at $trackingModel"
}

$cloudProblems = [Collections.Generic.List[string]]::new()
if (-not $values.ContainsKey("GEMINI_API_KEY") -or -not $values["GEMINI_API_KEY"]) {
  $cloudProblems.Add("GEMINI_API_KEY is empty in .env.")
}
if (-not $values.ContainsKey("GOOGLE_CLOUD_PROJECT") -or -not $values["GOOGLE_CLOUD_PROJECT"]) {
  $cloudProblems.Add("GOOGLE_CLOUD_PROJECT is empty in .env.")
}
$adcPath = Join-Path $env:APPDATA "gcloud\application_default_credentials.json"
if (-not (Test-Path -LiteralPath $adcPath)) {
  $cloudProblems.Add("Google Application Default Credentials are missing. Run gcloud auth application-default login.")
}

if ($cloudProblems.Count -eq 0) {
  Pass "Gemini and Google Cloud configuration"
} elseif ($RequireCloud) {
  foreach ($problem in $cloudProblems) { Fail $problem }
} else {
  foreach ($problem in $cloudProblems) { Write-Output "[CLOUD TODO] $problem" }
}

if ($failures.Count -gt 0) {
  Write-Output ""
  Write-Output "Setup verification failed with $($failures.Count) required item(s) missing."
  exit 1
}

Write-Output ""
Write-Output "Local runtime verification passed."
exit 0
