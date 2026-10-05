# FrameBoost NVIDIA helper: first-time setup.
#   1. checks GPU / driver / ffmpeg
#   2. installs the NVIDIA VFX SDK from the two files you download from NGC (not redistributable, so it is not bundled)
#   3. checks that everything is ready
# Run from the folder of the helper:   powershell -ExecutionPolicy Bypass -File .\setup.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$sdkRoot = Join-Path $root 'sdk\core\VideoFX'
$coreZip = 'VFXSDK_windows_1.3.0.0.zip'
$featZip = '1.3.0.0_lib_windows.zip'
$ngcCore = 'https://catalog.ngc.nvidia.com/orgs/nvidia/maxine/resources/vfx_sdk_core'
$ngcFeat = 'https://catalog.ngc.nvidia.com/orgs/nvidia/maxine/models/nvvfxvideoframegeneration'

function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  OK   $t" -ForegroundColor Green }
function Bad($t) { Write-Host "  FAIL $t" -ForegroundColor Red }
$problems = @()

Step 'GPU and driver'
try {
  $g = (& nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>$null | Select-Object -First 1)
  if (-not $g) { throw 'no output' }
  $name, $drv = $g -split ',\s*'
  Ok "$name (driver $drv)"
  if ($name -notmatch 'RTX\s*(40|50)\d\d|Ada|Blackwell|L40|RTX\s*(4|5)000') { Write-Host '  note: Video Frame Generation needs an Ada/Blackwell GPU (RTX 40/50 series).' -ForegroundColor Yellow }
  if ([version]($drv -replace '[^\d.]', '') -lt [version]'570.65') { Write-Host '  note: driver 570.65 or newer is required.' -ForegroundColor Yellow }
} catch { Bad 'nvidia-smi not found: install the NVIDIA driver'; $problems += 'driver' }

Step 'ffmpeg (with libx264)'
try {
  $enc = & ffmpeg -hide_banner -encoders 2>$null
  if ($enc -match 'libx264') { Ok (& ffmpeg -hide_banner -version | Select-Object -First 1) } else { Bad 'ffmpeg found but without libx264'; $problems += 'ffmpeg' }
} catch {
  Bad 'ffmpeg not found in PATH. Install it with:  winget install Gyan.FFmpeg   (then open a new terminal)'
  $problems += 'ffmpeg'
}

Step 'NVIDIA VFX SDK (Video Frame Generation)'
function SdkReady { (Test-Path (Join-Path $sdkRoot 'bin\NVVideoEffects.dll')) -and (Test-Path (Join-Path $sdkRoot 'features\nvvfxvideoframegeneration\bin\nvVFXVideoFrameGeneration.dll')) }
if (-not (SdkReady)) {
  $dirs = @($root, (Join-Path $root 'downloads'), (Join-Path $env:USERPROFILE 'Downloads')) | Where-Object { Test-Path $_ }
  $core = $dirs | ForEach-Object { Join-Path $_ $coreZip } | Where-Object { Test-Path $_ } | Select-Object -First 1
  $feat = $dirs | ForEach-Object { Join-Path $_ $featZip } | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $core -or -not $feat) {
    Write-Host @"
  The SDK is NVIDIA's software and is not redistributed here. Download two files from NGC (free NVIDIA account,
  accept NVIDIA's license there), save them in your Downloads folder, then run this script again:

    1. $coreZip      (~1 GB)   resource vfx_sdk_core, version 1.3.0.0_windows
       $ngcCore
    2. $featZip      (~177 MB) model nvvfxvideoframegeneration, version 1.3.0.0_lib_windows
       $ngcFeat
       (on each page: version drop-down -> pick the version above -> File Browser tab -> ⋮ -> Download)

"@ -ForegroundColor Yellow
    $a = Read-Host 'Open both NGC pages in your browser now? [y/N]'
    if ($a -match '^[yY]') { Start-Process $ngcCore; Start-Process $ngcFeat }
    $problems += 'sdk'
  } else {
    Write-Host "  found $core"; Write-Host "  found $feat"
    New-Item -ItemType Directory -Force (Join-Path $root 'sdk\core') | Out-Null
    Write-Host '  extracting SDK Core (this takes a minute)...'
    Expand-Archive -Path $core -DestinationPath (Join-Path $root 'sdk\core') -Force
    Write-Host '  extracting Video Frame Generation feature...'
    Expand-Archive -Path $feat -DestinationPath (Join-Path $sdkRoot 'features') -Force
  }
}
if (SdkReady) { Ok "SDK installed at $sdkRoot" } elseif ($problems -notcontains 'sdk') { Bad 'SDK files not where expected'; $problems += 'sdk' }

Step 'Result'
if ($problems.Count -eq 0) {
  Write-Host "  Ready. Start the helper with  start-helper.bat  and paste the pairing token in FrameBoost (popup > Engine > NVIDIA)." -ForegroundColor Green
} else {
  Write-Host "  Not ready yet: $($problems -join ', '). Fix the items above and run this script again." -ForegroundColor Yellow
  exit 1
}
