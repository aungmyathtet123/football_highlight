param([string]$Destination = "")
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path $projectRoot "tools\ffmpeg-full" }
$installRoot = [IO.Path]::GetFullPath($Destination)
$binary = Join-Path $installRoot "bin\ffmpeg.exe"
if (Test-Path -LiteralPath $binary) {
  $decoders = & $binary -hide_banner -decoders 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0 -and $decoders -match "\blibdav1d\b") {
    Write-Output "Fast AV1 decoder already installed: $binary"
    exit 0
  }
  throw "The destination already contains another FFmpeg build. Choose a new destination; no existing binary was overwritten."
}
$downloadRoot = Join-Path $projectRoot ("work\ffmpeg-full-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $downloadRoot | Out-Null
$archive = Join-Path $downloadRoot "ffmpeg-release-full.7z"
$url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z"
$ProgressPreference = "SilentlyContinue"
Write-Output "Downloading the full FFmpeg build with dav1d..."
Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
$checksum = (Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256").Content
if ($checksum -notmatch "(?i)[a-f0-9]{64}") { throw "No published SHA-256 checksum was returned." }
$expected = $Matches[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expected) {
  throw "Checksum mismatch. The downloaded binary was not installed."
}
$members = & tar -tf $archive
if ($LASTEXITCODE -ne 0) { throw "Windows tar cannot inspect this archive." }
foreach ($member in $members) {
  if ($member -match "(^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$))") {
    throw "Archive member escapes the extraction directory."
  }
}
$expanded = Join-Path $downloadRoot "expanded"
New-Item -ItemType Directory -Path $expanded | Out-Null
& tar -xf $archive -C $expanded
if ($LASTEXITCODE -ne 0) { throw "Archive extraction failed." }
$sourceBinary = Get-ChildItem -LiteralPath $expanded -File -Filter ffmpeg.exe -Recurse | Select-Object -First 1
if (-not $sourceBinary) { throw "Verified archive has no FFmpeg executable." }
$sourceBin = $sourceBinary.Directory.FullName
New-Item -ItemType Directory -Path (Join-Path $installRoot "bin") -Force | Out-Null
foreach ($name in @("ffmpeg.exe", "ffprobe.exe", "ffplay.exe")) {
  $source = Join-Path $sourceBin $name
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $installRoot "bin\$name") }
}
$decoders = & $binary -hide_banner -decoders 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $decoders -notmatch "\blibdav1d\b") { throw "Installed build lacks dav1d." }
Write-Output "Verified full build installed: $binary"
Write-Output "No environment settings or running workers were changed. Download retained at $downloadRoot"
