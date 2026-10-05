# FrameBoost NVIDIA helper

A small local program that gives the **FrameBoost** browser extension **NVIDIA Frame Generation**
(Maxine Video Effects SDK, *Video Frame Generation*). You start it on your PC, FrameBoost sends it the video you are
watching as H.264, it returns the generated in-between frames, and FrameBoost shows them in real time:
YouTube at 24 fps becomes 144 fps on a 144 Hz display, with the audio kept in sync.
Everything stays on your computer (the helper only listens on `127.0.0.1`).

```
page <video> ─▶ FrameBoost (WebCodecs H.264 encode, hardware)
               ─▶ extension relay iframe ─▶ ws://127.0.0.1:8765/live
                    helper:  ffmpeg decode ─▶ vfgpipe (Maxine VFG, CUDA) ─▶ ffmpeg x264 (zerolatency)
               ◀─ generated frames (H.264) ◀─
FrameBoost decodes them (WebCodecs) and shows the nearest frame of a slightly delayed timeline;
the audio is delayed by the same amount so lip-sync is kept.
```

## Requirements
- Windows 10/11 x64 and an NVIDIA **RTX 40/50 series** GPU (Ada/Blackwell), driver **570.65 or newer**
- `ffmpeg` with `libx264` in `PATH` (`winget install Gyan.FFmpeg`)
- The **NVIDIA VFX SDK** + Video Frame Generation feature from NGC (free NVIDIA account): see step 2 — not bundled, NVIDIA's
  license does not allow redistributing it
- A Chromium browser (Brave, Chrome, Edge…) with the **FrameBoost** extension version that includes the NVIDIA engine

## Quick start (release download)
1. Download `frameboost-nvidia-helper-vX.Y.Z-win-x64.zip` from the **Releases** page and extract it anywhere.
2. Run `powershell -ExecutionPolicy Bypass -File setup.ps1`. It checks the GPU/driver/ffmpeg and tells you which two files to
   download from NGC (`VFXSDK_windows_1.3.0.0.zip` and `1.3.0.0_lib_windows.zip`). Save them in your Downloads folder, run
   `setup.ps1` again and it unpacks them into `sdk\`.
3. Start `start-helper.bat`. It prints a **pairing token** and shows `ready: NVIDIA GeForce RTX … · Maxine VFX SDK 1.3.0.0`.
   (Windows SmartScreen may warn about the unsigned `.exe`: *More info → Run anyway*.)
4. In the browser: FrameBoost popup → **Engine** → **NVIDIA**, paste the token → *Save*. The status line reads
   `NVIDIA GeForce RTX … · SDK … · ready`.
5. Open a video. The badge on it reads e.g. `24 → 144 fps` and `NVIDIA ×6`. If the helper is not running FrameBoost keeps
   using its built-in WebGPU engine; if it stops mid-video FrameBoost switches back by itself.

The token is stored in `config.json` next to the exe; the status page `http://127.0.0.1:8765` shows it behind a button.

## Build from source
Needs Node.js ≥ 20, Visual Studio 2022 (C++) and CMake ≥ 3.21, plus the SDK Core extracted into `sdk\core\`.
```
npm install
powershell -File scripts\build.ps1      # bin\vfgpipe.exe  (uses sdkRoot from config.json, or .\sdk\core\VideoFX)
start-helper.bat                        # node server\live.mjs
npm run release                         # single-exe release archive in dist\ (Node SEA + esbuild)
```
`scripts/protocol-test.mjs <video> [multiplier] [fps]` plays the extension's part against a running helper.

## Security
Loopback only. The WebSocket accepts only `chrome-extension://…` origins that present the pairing token; web pages cannot
connect (the browser blocks public sites from reaching `127.0.0.1`, and the helper checks `Origin` and `Host`).

## Notes
- **x264, not NVENC, for the return stream:** the browser's hardware H.264 decoder holds back a whole DPB (4–16 frames,
  70–270 ms) unless the SPS declares `max_num_reorder_frames=0`; x264 `zerolatency` writes it, ffmpeg's NVENC output does not.
  (`"encoder": "nvenc"` in `config.json` exists for experiments.)
- Measured on an RTX 4090: helper chain at 1080p60 ×2 ≈ 47 ms p50 / 61 ms p95; end to end in the browser ≈ 110–180 ms, which
  FrameBoost hides by delaying video and audio together by ≈ 190–300 ms.
- Limits: DRM video, one NVIDIA session per helper connection, 1080p-class content (4K is not real-time).
- Protocol and design: FrameBoost `docs/superpowers/specs/2026-10-05-nvidia-frame-generation-backend-design.md`.

## Licenses
This project is MIT licensed (`LICENSE`). `bin/vfgpipe.exe` embeds MIT-licensed glue code from NVIDIA's SDK and
`frameboost-helper.exe` embeds Node.js and `ws`: see `THIRD_PARTY_NOTICES.md`. The NVIDIA VFX SDK itself is under
NVIDIA's license and is installed by each user from NGC.
