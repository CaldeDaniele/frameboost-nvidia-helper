# FrameBoost NVIDIA helper

A small local program that gives the **FrameBoost** browser extension **NVIDIA Frame Generation**
(Maxine Video Effects SDK, *Video Frame Generation*). FrameBoost sends it the video you are watching as H.264, it returns
the generated in-between frames, and FrameBoost shows them in real time: YouTube at 24 fps becomes 144 fps on a 144 Hz
display, with the audio kept in sync. Everything stays on your computer (the helper only listens on `127.0.0.1`).

```
page <video> ─▶ FrameBoost (WebCodecs H.264 encode, hardware)
               ─▶ extension relay iframe ─▶ ws://127.0.0.1:<port>/live
                    helper:  ffmpeg decode ─▶ vfgpipe (Maxine VFG, CUDA) ─▶ ffmpeg x264 (zerolatency)
               ◀─ generated frames (H.264) ◀─
FrameBoost decodes them (WebCodecs) and shows the nearest frame of a slightly delayed timeline;
the audio is delayed by the same amount so lip-sync is kept.
```

## For users: install in a few clicks

**Step-by-step guide with screenshots:** [English](docs/GUIDE.md) · [Italiano](docs/GUIDA.md) · video: [English](docs/guide-en.mp4) · [Italiano](docs/guide-it.mp4)

1. In FrameBoost, open the popup → **Set up NVIDIA Frame Generation** (or **Engine → NVIDIA**). The setup page checks your
   PC and offers the installer.
2. Run **`FrameBoost-NVIDIA-Setup.exe`** (also on the [Releases](../../releases/latest) page). A local page opens in your
   browser and goes through four steps:
   - **PC check**: RTX 40/50 GPU (Ada/Blackwell) and NVIDIA driver 570.65 or newer.
   - **FFmpeg**: one button downloads it if it is not on the PC.
   - **NVIDIA components**: NVIDIA does not allow redistributing its SDK, so you download two files from NVIDIA NGC with
     your own free NVIDIA account (the installer opens both pages and lists the file names). When they land in your
     Downloads folder the installer notices them and unpacks them by itself.
   - **Install**: copies the helper to `%LOCALAPPDATA%\FrameBoostNvidia` (no administrator rights) and registers it as a
     *Native Messaging* host for Chrome, Brave, Edge and Chromium.
3. Back in the extension, the setup page turns green by itself. Open any video: the badge reads e.g. `24 → 144 fps`
   and `NVIDIA ×6`.

There is no token to copy: the extension starts the helper when a video needs it (a few hundred milliseconds) and the
helper quits 15 seconds after the last video stops. If the helper is missing or fails, FrameBoost keeps using its
built-in WebGPU engine, and switches back by itself if the helper stops mid-video.

Windows SmartScreen may warn about the unsigned `.exe`: *More info → Run anyway*. To remove everything: run the installer
again and use **Uninstall** (or `FrameBoost-NVIDIA-Setup.exe --uninstall`).

### Requirements
- Windows 10/11 x64 and an NVIDIA **RTX 40/50 series** GPU, driver **570.65 or newer**
- A Chromium browser (Brave, Chrome, Edge…) with a FrameBoost version that includes the NVIDIA engine

## Command line

| Command | What it does |
| --- | --- |
| `FrameBoost-NVIDIA-Setup.exe` | installer wizard (default) |
| `--register [--allow <extension id>]` | register the native host again, optionally also for a development extension id |
| `--unregister` / `--uninstall` | remove the registration / remove everything |
| `--check` | print what is missing (GPU, driver, FFmpeg, SDK) and exit |
| `--serve` | run the helper by hand on a fixed port with a long-lived pairing token and a status page (`http://127.0.0.1:8765`); used with the token fields under *Advanced* in the popup |
| `--version`, `--help` | |

The browser starts the helper itself with `chrome-extension://<id>/` as the only argument (Native Messaging); that mode
is not meant to be run by hand. The helper reports `ready{port, token}` per start and exits when the browser closes the
pipe or sends `{"t":"quit"}`. The one-time token and the browser's `Origin` are both checked on the WebSocket.

## Build from source
Needs Node.js 25.5+ (for `node --build-sea`; running from source works with Node 20+), Visual Studio 2022 (C++) and CMake ≥ 3.21, plus the SDK Core extracted into `sdk\core\`.
```
npm install
powershell -File scripts\build.ps1            # bin\vfgpipe.exe (uses sdkRoot from config.json, or .\sdk\core\VideoFX)
npm run wizard                                # the installer wizard from source
npm run release                               # dist\FrameBoost-NVIDIA-Setup.exe (Node SEA + esbuild) and its .sha256
npm run test:native -- dist\FrameBoost-NVIDIA-Setup.exe   # native host checks (source or exe)
```
`scripts/protocol-test.mjs <video> [multiplier] [fps]` plays the extension's part against a running helper (`--serve`).

## Security
Loopback only. The WebSocket accepts only the `chrome-extension://…` origin that launched the helper (or, in `--serve`
mode, an extension that presents the pairing token); web pages cannot connect (the browser blocks public sites from
reaching `127.0.0.1`, and the helper checks `Origin` and `Host`). The installer page is served on a random port, guarded by
a one-time token and a `Host` check. The native host manifest allows only the FrameBoost extension ids
(`allowed_origins`).

## Notes
- **x264, not NVENC, for the return stream:** the browser's hardware H.264 decoder holds back a whole DPB (4–16 frames,
  70–270 ms) unless the SPS declares `max_num_reorder_frames=0`; x264 `zerolatency` writes it, ffmpeg's NVENC output does not.
  (`"encoder": "nvenc"` in `config.json` exists for experiments.)
- Measured on an RTX 4090: helper chain at 1080p60 ×2 ≈ 47 ms p50 / 61 ms p95; end to end in the browser ≈ 110–180 ms, which
  FrameBoost hides by delaying video and audio together by ≈ 190–300 ms.
- Limits: DRM video, one NVIDIA session per helper connection, 1080p-class content (4K is not real-time).
- Protocol and design: FrameBoost `docs/superpowers/specs/2026-10-05-nvidia-frame-generation-backend-design.md`.

## Licenses
This project is MIT licensed (`LICENSE`). `vfgpipe.exe` embeds MIT-licensed glue code from NVIDIA's SDK and
the executable embeds Node.js and `ws`: see `THIRD_PARTY_NOTICES.md`. The NVIDIA VFX SDK itself is under NVIDIA's license
and is installed by each user from NGC; FFmpeg (GPL build) is downloaded by the installer when the user clicks the button.
