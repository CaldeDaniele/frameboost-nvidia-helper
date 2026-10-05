# Builds the release file:  dist\FrameBoost-NVIDIA-Setup.exe  (+ .sha256)
# One executable that is both the installer wizard (double click) and, once installed, the native messaging host / helper.
# It embeds: the server (Node SEA + esbuild bundle), bin\vfgpipe.exe, the wizard page, LICENSE and THIRD_PARTY_NOTICES.
# bin\vfgpipe.exe must be built first with scripts\build.ps1. The NVIDIA SDK is NOT part of the file.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
if (-not (Test-Path 'bin\vfgpipe.exe')) { throw 'bin\vfgpipe.exe missing: run scripts\build.ps1 first' }
if (-not (Test-Path 'node_modules\esbuild')) { npm install --no-audit --no-fund; if ($LASTEXITCODE) { exit $LASTEXITCODE } }

New-Item -ItemType Directory -Force dist | Out-Null
npx esbuild server/main.mjs --bundle --platform=node --format=cjs --target=node22 --external:bufferutil --external:utf-8-validate --outfile=dist/helper.cjs --log-level=error
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$cfg = [ordered]@{
  main = 'dist/helper.cjs'; output = 'dist/FrameBoost-NVIDIA-Setup.exe'; disableExperimentalSEAWarning = $true; useCodeCache = $false
  assets = [ordered]@{ 'vfgpipe.exe' = 'bin/vfgpipe.exe'; 'ui.html' = 'server/setup/ui.html'; 'LICENSE' = 'LICENSE'; 'THIRD_PARTY_NOTICES.md' = 'THIRD_PARTY_NOTICES.md' }
}
$cfg | ConvertTo-Json | Set-Content dist\sea-config.json -Encoding ASCII
node --build-sea dist/sea-config.json
if ($LASTEXITCODE) { exit $LASTEXITCODE }

$exe = 'dist\FrameBoost-NVIDIA-Setup.exe'
$hash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
"$hash  FrameBoost-NVIDIA-Setup.exe" | Set-Content "$exe.sha256" -Encoding ASCII
"{0}  {1:N1} MB`nsha256 {2}" -f $exe, ((Get-Item $exe).Length / 1MB), $hash
