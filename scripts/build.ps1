# Builds bin\vfgpipe.exe (needs Visual Studio 2022 C++ tools + CMake >= 3.21).
# SDK location: -SdkRoot, else config.json "sdkRoot", else .\sdk\core\VideoFX
param([string]$SdkRoot)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $SdkRoot) {
  $cfg = Join-Path $root 'config.json'
  if (Test-Path $cfg) { $SdkRoot = (Get-Content $cfg -Raw | ConvertFrom-Json).sdkRoot }
}
if (-not $SdkRoot) { $SdkRoot = Join-Path $root 'sdk\core\VideoFX' }
if (-not (Test-Path (Join-Path $SdkRoot 'nvvfx\include\nvVideoEffects.h'))) {
  Write-Error "VFX SDK not found at '$SdkRoot'. Install it (see README) and set sdkRoot in config.json."
}
$SdkRoot = $SdkRoot -replace '\\', '/'
cmake -S "$root\vfgpipe" -B "$root\vfgpipe\build" -G "Visual Studio 17 2022" -A x64 "-DVFXSDK_ROOT=$SdkRoot"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
cmake --build "$root\vfgpipe\build" --config Release
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Write-Host "OK -> $root\bin\vfgpipe.exe"
