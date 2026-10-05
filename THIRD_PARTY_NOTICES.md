# Third-party notices

This project's own code is MIT licensed (see `LICENSE`). The release binaries contain or use the following.

## NVIDIA Video Effects SDK — NOT included

The NVIDIA Maxine Video Effects (VFX) SDK, its DLLs, models and the Video Frame Generation feature are **not part of
this project and are not redistributed** with it. Each user downloads them from NVIDIA NGC with their own account and
is bound by NVIDIA's own license terms (NVIDIA Software License Agreement and Product-Specific Terms, shipped inside the
SDK). `bin/vfgpipe.exe` loads them at run time from the user's installation.

## NVIDIA SDK proxy sources and headers — compiled into `vfgpipe.exe` (MIT)

`vfgpipe.exe` is built from `vfgpipe/main.cpp` together with NVIDIA's `nvCVImageProxy.cpp` and
`nvVideoEffectsProxy.cpp` and the headers `nvVideoEffects.h`, `nvCVImage.h`, `nvCVStatus.h` from the SDK Core
(`nvvfx/`). These files carry the following notice, reproduced as required:

> Copyright (c) 2020 NVIDIA Corporation
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
> Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

(`nvCVImage.h` is copyright 2020-2021 NVIDIA Corporation under the same terms.) The parameter names of the
VideoFrameGeneration effect are defined independently in `vfgpipe/vfg_params.h`; NVIDIA's feature header
`nvVFXVideoFrameGeneration.h` is neither included nor redistributed.

## ws — WebSocket library (MIT), bundled in `frameboost-helper.exe`

> Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
> Copyright (c) 2013 Arnout Kazemier and contributors
> Copyright (c) 2016 Luigi Pinca and contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
> Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Node.js runtime (MIT and others), inside `FrameBoost-NVIDIA-Setup.exe` / `frameboost-helper.exe`

The executable is a Node.js single-executable application: it embeds the Node.js runtime. Node.js is licensed under the
MIT license with additional third-party notices; the full text is at <https://github.com/nodejs/node/blob/main/LICENSE>.

## FFmpeg — NOT included, downloaded by the installer on request

The helper calls an `ffmpeg` executable. It is not part of this project's releases. If FFmpeg is not found on the PC, the
installer offers to download it **when the user clicks the button**: a `ffmpeg-release-essentials` build from
<https://www.gyan.dev/ffmpeg/builds/> (checked against the SHA-256 published next to it; fallback: the `win64-gpl` build of
<https://github.com/BtbN/FFmpeg-Builds>) and unpacks it into `%LOCALAPPDATA%\FrameBoostNvidiafmpeg\`, together with its
own `LICENSE`. These builds include `libx264` and are GPL-licensed: because the helper only starts `ffmpeg` as a separate
process, that license applies to FFmpeg itself, not to this project. Source code of the downloaded build is available from
the sites above.
