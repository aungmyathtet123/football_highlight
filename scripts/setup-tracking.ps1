$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$venvRoot = Join-Path $projectRoot ".venv-tracking"
$venvPython = Join-Path $venvRoot "Scripts\python.exe"
$modelDirectory = Join-Path $projectRoot "tools\tracking"

if (-not (Test-Path -LiteralPath $venvPython)) {
  $systemPython = (Get-Command python.exe -ErrorAction Stop).Source
  & $systemPython -m venv $venvRoot
}

& $venvPython -m pip install --disable-pip-version-check --upgrade pip
& $venvPython -m pip install --disable-pip-version-check torch torchvision --index-url https://download.pytorch.org/whl/cpu
& $venvPython -m pip install --disable-pip-version-check ultralytics==8.4.52

New-Item -ItemType Directory -Force -Path $modelDirectory | Out-Null
Push-Location $modelDirectory
try {
  & $venvPython -c "from ultralytics import YOLO; YOLO('yolo11n.pt'); print('tracking model ready')"
} finally {
  Pop-Location
}

Write-Output "Local football tracking is ready."
