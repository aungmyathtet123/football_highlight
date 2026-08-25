Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$venvRoot = Join-Path $projectRoot ".venv-tracking"
$venvPython = Join-Path $venvRoot "Scripts/python.exe"
$modelDirectory = Join-Path $projectRoot "tools/tracking"
$requirementsPath = Join-Path $projectRoot "requirements-tracking.txt"

if (-not (Test-Path -LiteralPath $venvPython)) {
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($python) {
    $versionText = (& $python.Source -c "import sys; print('.'.join(map(str, sys.version_info[:3])))").Trim()
    $version = [version]$versionText
    if ($version -lt [version]"3.10.0" -or $version -ge [version]"3.13.0") {
      throw "Python 3.10, 3.11, or 3.12 is required. Found $versionText."
    }
    & $python.Source -m venv $venvRoot
  } elseif ($launcher) {
    $available = & $launcher.Source -0p
    $preferred = $available | Where-Object { $_ -match "-3.12-" } | Select-Object -First 1
    if (-not $preferred) {
      throw "Python 3.12 is required. Install it from https://www.python.org/downloads/windows/."
    }
    & $launcher.Source -3.12 -m venv $venvRoot
  } else {
    throw "Python 3.10-3.12 is required. Install Python 3.12 and enable 'Add python.exe to PATH'."
  }
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPython)) {
    throw "Could not create the tracking virtual environment."
  }
}

& $venvPython -m pip install --disable-pip-version-check --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Could not upgrade pip in the tracking environment." }
& $venvPython -m pip install --disable-pip-version-check "torch==2.13.0" "torchvision==0.28.0" --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw "Could not install the CPU PyTorch packages." }
& $venvPython -m pip install --disable-pip-version-check -r $requirementsPath
if ($LASTEXITCODE -ne 0) { throw "Could not install the pinned tracking requirements." }

New-Item -ItemType Directory -Force -Path $modelDirectory | Out-Null
Push-Location $modelDirectory
try {
  & $venvPython -c "from ultralytics import YOLO; YOLO('yolo11n.pt'); print('Tracking model ready.')"
  if ($LASTEXITCODE -ne 0) { throw "Could not download or load the YOLO11n tracking model." }
} finally {
  Pop-Location
}

& $venvPython -c "import cv2, torch, ultralytics; print(f'Python tracking ready: torch={torch.__version__}, ultralytics={ultralytics.__version__}, opencv={cv2.__version__}')"
if ($LASTEXITCODE -ne 0) { throw "Tracking dependency import verification failed." }

Write-Output "Local football tracking is ready."
