Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$venvRoot = Join-Path $projectRoot ".venv-tracking"
$venvPython = Join-Path $venvRoot "Scripts/python.exe"
$modelDirectory = Join-Path $projectRoot "tools/tracking"
$requirementsPath = Join-Path $projectRoot "requirements-tracking.txt"
$ballModelPath = Join-Path $modelDirectory "yolo-football-ball-detection.pt"
$ballModelDownload = Join-Path $modelDirectory "yolo-football-ball-detection.download"
$ballModelUrl = "https://huggingface.co/martinjolif/yolo-football-ball-detection/resolve/main/yolo-football-ball-detection.pt?download=true"
$ballModelSha256 = "FB37942448E7DE08745E8AAB148D0794F680A738DDD55E5F17ABE9AB2D6313FB"

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

$ballModelValid = (Test-Path -LiteralPath $ballModelPath) -and ((Get-FileHash -Algorithm SHA256 -LiteralPath $ballModelPath).Hash -eq $ballModelSha256)
if (-not $ballModelValid) {
  if (Test-Path -LiteralPath $ballModelDownload) { Remove-Item -LiteralPath $ballModelDownload -Force }
  Invoke-WebRequest -Uri $ballModelUrl -OutFile $ballModelDownload
  $downloadHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ballModelDownload).Hash
  if ($downloadHash -ne $ballModelSha256) {
    Remove-Item -LiteralPath $ballModelDownload -Force
    throw "The football ball model checksum did not match the verified release."
  }
  Move-Item -LiteralPath $ballModelDownload -Destination $ballModelPath -Force
}
& $venvPython -c "from ultralytics import YOLO; m=YOLO(r'$ballModelPath'); assert m.names == {0: 'ball'}; print('Football-specific ball model ready.')"
if ($LASTEXITCODE -ne 0) { throw "Could not load the football-specific ball model." }

$pitchModelPath = Join-Path $modelDirectory "yolo-football-pitch-detection.pt"
$pitchHash = "06623B51F77F51695CDE731DA146596E6DF73C95A5B4776F6AFE7094389ED209"
if (-not (Test-Path -LiteralPath $pitchModelPath)) {
  $pitchDownload = Join-Path $modelDirectory "pitch-model.download"
  Invoke-WebRequest -Uri "https://huggingface.co/martinjolif/yolo-football-pitch-detection/resolve/7e4e358d66715b1231260bf4a9ce68c542e04213/yolo-football-pitch-detection.pt?download=true" -OutFile $pitchDownload
  if ((Get-FileHash -LiteralPath $pitchDownload -Algorithm SHA256).Hash -ne $pitchHash) {
    throw "Pitch model checksum mismatch; downloaded file was not activated."
  }
  Move-Item -LiteralPath $pitchDownload -Destination $pitchModelPath
}
if ((Get-FileHash -LiteralPath $pitchModelPath -Algorithm SHA256).Hash -ne $pitchHash) {
  throw "Existing pitch model differs from the pinned release; it was not overwritten."
}

& $venvPython -c "import cv2, torch, ultralytics, supervision, lap, scenedetect; print(f'Python tracking ready: torch={torch.__version__}, ultralytics={ultralytics.__version__}, opencv={cv2.__version__}, supervision={supervision.__version__}, scenedetect={scenedetect.__version__}')"
if ($LASTEXITCODE -ne 0) { throw "Tracking dependency import verification failed." }

Write-Output "Local football tracking is ready."
