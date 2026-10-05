# Builds the release archive:  dist\frameboost-nvidia-helper-v<version>-win-x64.zip  (+ .sha256)
#   frameboost-helper.exe  (Node single-executable: server + ws, from server\live.mjs)
#   bin\vfgpipe.exe        (must be built first with scripts\build.ps1)
# The NVIDIA SDK is NOT part of the archive.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
if (-not (Test-Path 'bin\vfgpipe.exe')) { throw 'bin\vfgpipe.exe missing: run scripts\build.ps1 first' }
if (-not (Test-Path 'node_modules\esbuild')) { npm install --no-audit --no-fund; if ($LASTEXITCODE) { exit $LASTEXITCODE } }

New-Item -ItemType Directory -Force dist | Out-Null
npx esbuild server/live.mjs --bundle --platform=node --format=cjs --target=node22 --external:bufferutil --external:utf-8-validate --outfile=dist/helper.cjs --log-level=error
if ($LASTEXITCODE) { exit $LASTEXITCODE }
'{ "main": "dist/helper.cjs", "output": "dist/frameboost-helper.exe", "disableExperimentalSEAWarning": true, "useCodeCache": false }' | Set-Content dist\sea-config.json -Encoding ASCII
node --build-sea dist/sea-config.json
if ($LASTEXITCODE) { exit $LASTEXITCODE }

$name = "frameboost-nvidia-helper-v$version-win-x64"
$stage = Join-Path 'dist' $name
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$stage\bin", "$stage\licenses" | Out-Null
Copy-Item dist\frameboost-helper.exe $stage
Copy-Item bin\vfgpipe.exe "$stage\bin"
Copy-Item setup.ps1, start-helper.bat, README.md, LICENSE, THIRD_PARTY_NOTICES.md $stage
$nodeLicense = Join-Path (Split-Path (Get-Command node).Source) 'LICENSE'
if (Test-Path $nodeLicense) { Copy-Item $nodeLicense "$stage\licenses\NODE_LICENSE.txt" } else { Write-Warning 'Node LICENSE not found next to node.exe: add licenses\NODE_LICENSE.txt by hand' }
Copy-Item node_modules\ws\LICENSE "$stage\licenses\WS_LICENSE.txt"

$zip = Join-Path 'dist' "$name.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Push-Location dist
tar.exe -a -c -f "$name.zip" $name        # bsdtar writes a proper zip (Compress-Archive on PS 5.1 writes backslash paths)
Pop-Location
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"$hash  $name.zip" | Set-Content "$zip.sha256" -Encoding ASCII
"{0}  {1:N1} MB`nsha256 {2}" -f $zip, ((Get-Item $zip).Length / 1MB), $hash
