[CmdletBinding()]
param(
  [switch]$ConfigureCloud,
  [switch]$SkipNpm,
  [switch]$SkipFfmpeg,
  [switch]$SkipTracking
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
$envTemplatePath = Join-Path $projectRoot ".env.example"
$ffmpegDownloadRoot = Join-Path $projectRoot "tools/ffmpeg-download"
$ffmpegInstallRoot = Join-Path $projectRoot "tools/ffmpeg/bin"
$ffmpegPath = Join-Path $ffmpegInstallRoot "ffmpeg.exe"
$ffprobePath = Join-Path $ffmpegInstallRoot "ffprobe.exe"

function Require-Command([string]$name, [string]$installHelp) {
  $command = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "$name is required. $installHelp"
  }
  return $command.Source
}

function Set-EnvValue([string]$key, [string]$value) {
  $lines = if (Test-Path -LiteralPath $envPath) {
    [Collections.Generic.List[string]](Get-Content -LiteralPath $envPath)
  } else {
    [Collections.Generic.List[string]]::new()
  }
  $prefix = "$key="
  $found = $false
  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    if ($lines[$index].StartsWith($prefix, [StringComparison]::Ordinal)) {
      $lines[$index] = "$prefix$value"
      $found = $true
      break
    }
  }
  if (-not $found) {
    $lines.Add("$prefix$value")
  }
  [IO.File]::WriteAllLines($envPath, $lines, [Text.UTF8Encoding]::new($false))
}

function Get-EnvValue([string]$key) {
  if (-not (Test-Path -LiteralPath $envPath)) { return "" }
  $prefix = "$key="
  $line = Get-Content -LiteralPath $envPath | Where-Object {
    $_.StartsWith($prefix, [StringComparison]::Ordinal)
  } | Select-Object -First 1
  if (-not $line) { return "" }
  return $line.Substring($prefix.Length).Trim().Trim('"').Trim("'")
}

function Install-Ffmpeg {
  if ((Test-Path -LiteralPath $ffmpegPath) -and (Test-Path -LiteralPath $ffprobePath)) {
    Write-Output "FFmpeg and FFprobe are already installed."
    return
  }

  $archiveUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
  $checksumUrl = "$archiveUrl.sha256"
  $archivePath = Join-Path $ffmpegDownloadRoot "ffmpeg-release-essentials.zip"
  $checksumPath = "$archivePath.sha256"
  $expandedRoot = Join-Path $ffmpegDownloadRoot "expanded"

  New-Item -ItemType Directory -Force -Path $ffmpegDownloadRoot, $ffmpegInstallRoot, $expandedRoot | Out-Null
  Write-Output "Downloading the FFmpeg Windows Essentials build..."
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
  Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumPath

  $publishedChecksum = ((Get-Content -LiteralPath $checksumPath -Raw) -match "(?i)[a-f0-9]{64}")
  if (-not $publishedChecksum) {
    throw "The FFmpeg checksum file did not contain a SHA-256 value."
  }
  $expectedChecksum = $Matches[0].ToUpperInvariant()
  $actualChecksum = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actualChecksum -ne $expectedChecksum) {
    throw "FFmpeg checksum verification failed. The archive was not installed."
  }

  Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedRoot -Force
  $downloadedFfmpeg = Get-ChildItem -LiteralPath $expandedRoot -Filter "ffmpeg.exe" -File -Recurse |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $downloadedFfprobe = Get-ChildItem -LiteralPath $expandedRoot -Filter "ffprobe.exe" -File -Recurse |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $downloadedFfmpeg -or -not $downloadedFfprobe) {
    throw "The verified FFmpeg archive did not contain ffmpeg.exe and ffprobe.exe."
  }
  Copy-Item -LiteralPath $downloadedFfmpeg.FullName -Destination $ffmpegPath -Force
  Copy-Item -LiteralPath $downloadedFfprobe.FullName -Destination $ffprobePath -Force
  Write-Output "FFmpeg and FFprobe are installed under tools/ffmpeg/bin."
}

function Configure-GoogleCloud {
  $gcloud = Require-Command "gcloud.cmd" "Install Google Cloud CLI, reopen PowerShell, and run this setup again with -ConfigureCloud."
  $project = Get-EnvValue "GOOGLE_CLOUD_PROJECT"
  if (-not $project) {
    $project = (Read-Host "Google Cloud project ID").Trim()
    if (-not $project) { throw "GOOGLE_CLOUD_PROJECT is required." }
    Set-EnvValue "GOOGLE_CLOUD_PROJECT" $project
  }

  if (-not (Get-EnvValue "GEMINI_API_KEY")) {
    $secret = Read-Host "Gemini API key (input is hidden)" -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try {
      $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    if (-not $apiKey) { throw "GEMINI_API_KEY is required." }
    Set-EnvValue "GEMINI_API_KEY" $apiKey
  }

  & $gcloud config set project $project
  & $gcloud services enable aiplatform.googleapis.com videointelligence.googleapis.com texttospeech.googleapis.com --project $project
  & $gcloud auth application-default login
  & $gcloud auth application-default set-quota-project $project
}

Push-Location $projectRoot
try {
  $node = Require-Command "node.exe" "Install Node.js 22.13 or newer from https://nodejs.org/."
  $npm = Require-Command "npm.cmd" "Install Node.js 22.13 or newer from https://nodejs.org/."
  $nodeVersionText = (& $node --version).Trim().TrimStart("v")
  $nodeVersion = [version]$nodeVersionText
  if ($nodeVersion -lt [version]"22.13.0") {
    throw "Node.js 22.13.0 or newer is required. Found $nodeVersionText."
  }

  if (-not (Test-Path -LiteralPath $envPath)) {
    Copy-Item -LiteralPath $envTemplatePath -Destination $envPath
    Write-Output "Created private .env from .env.example."
  }
  Set-EnvValue "SITE_URL" "http://localhost:3000"
  Set-EnvValue "NEXT_PUBLIC_PROCESSOR_URL" "http://127.0.0.1:8787"
  Set-EnvValue "FFMPEG_PATH" "./tools/ffmpeg/bin/ffmpeg.exe"
  Set-EnvValue "FFPROBE_PATH" "./tools/ffmpeg/bin/ffprobe.exe"

  if (-not $SkipNpm) {
    Write-Output "Installing exact Node.js dependencies from package-lock.json..."
    & $npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
  }
  if (-not $SkipFfmpeg) { Install-Ffmpeg }
  if (-not $SkipTracking) {
    & (Join-Path $PSScriptRoot "setup-tracking.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Local tracking setup failed." }
  }
  if ($ConfigureCloud) { Configure-GoogleCloud }

  & (Join-Path $PSScriptRoot "verify-setup.ps1") -RequireCloud:$ConfigureCloud
  if ($LASTEXITCODE -ne 0) { throw "Setup verification failed." }

  Write-Output ""
  Write-Output "Setup complete."
  if (-not $ConfigureCloud) {
    Write-Output "Cloud credentials were not configured. Edit .env, then run:"
    Write-Output "  powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -SkipNpm -SkipFfmpeg -SkipTracking -ConfigureCloud"
  }
  Write-Output "Start the application with: npm run local:start"
  Write-Output "Then open: http://localhost:3000"
} finally {
  Pop-Location
}
