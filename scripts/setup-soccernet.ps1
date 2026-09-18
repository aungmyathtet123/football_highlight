Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$venvRoot = Join-Path $projectRoot ".venv-soccernet"
$venvPython = Join-Path $venvRoot "Scripts/python.exe"
$repoRoot = Join-Path $projectRoot "tools/external/soccernet-sn-spotting"
$requirements = Join-Path $projectRoot "requirements-soccernet.txt"
$model = Join-Path $repoRoot "Benchmarks/CALF/models/CALF_benchmark/model.pth.tar"

if (-not (Test-Path -LiteralPath $venvPython)) {
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($python) {
    $versionText = (& $python.Source -c "import sys; print('.'.join(map(str, sys.version_info[:3])))").Trim()
    $version = [version]$versionText
    if ($version.Major -ne 3 -or $version.Minor -ne 10) { throw "SoccerNet CALF requires Python 3.10. Found $versionText." }
    & $python.Source -m venv $venvRoot
  } elseif ($launcher) {
    & $launcher.Source -3.10 -m venv $venvRoot
  } else {
    throw "Python 3.10 is required for TensorFlow 2.10 and SoccerNet CALF."
  }
}
if (-not (Test-Path -LiteralPath $venvPython)) { throw "Could not create .venv-soccernet." }

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot ".git"))) {
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) { throw "Git is required to install the official SoccerNet action spotter." }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $repoRoot) | Out-Null
  & $git.Source clone --depth 1 https://github.com/SoccerNet/sn-spotting.git $repoRoot
  if ($LASTEXITCODE -ne 0) { throw "Could not clone the official SoccerNet action-spotting repository." }
}

& $venvPython -m pip install --disable-pip-version-check --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Could not upgrade pip in the SoccerNet environment." }
& $venvPython -m pip install --disable-pip-version-check -r $requirements
if ($LASTEXITCODE -ne 0) { throw "Could not install the pinned SoccerNet dependencies." }
if (-not (Test-Path -LiteralPath $model)) { throw "The official CALF_benchmark pretrained weights are missing." }
$env:TF_CPP_MIN_LOG_LEVEL = "3"
& $venvPython -c "import tensorflow, torch, SoccerNet; print('SoccerNet CALF environment ready.')"
if ($LASTEXITCODE -ne 0) { throw "SoccerNet CALF packages could not be imported." }