// vfgpipe — NVIDIA Maxine Video Frame Generation as a stdin/stdout filter.
//
// stdin : raw BGR24 frames, W*H*3 bytes each, back to back (e.g. from `ffmpeg -f rawvideo -pix_fmt bgr24 -`)
// stdout: raw BGR24 frames: for every input pair (prev, curr) the generated intermediates, then curr.
//         The very first input frame is passed through unchanged.
//         With --only-generated only the generated intermediates are written (live use: the caller already
//         has the originals). stdout is flushed after every pair either way.
// stderr: log + machine-readable lines:  VFGREADY | VFGPROGRESS <input frames done> | VFGERROR <text> | VFGDONE <in> <out>
//
// Built against the VFX SDK proxies (dynamic loading of NVVideoEffects.dll / NVCVImage.dll), no OpenCV.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <string>
#include <vector>

#include "nvCVImage.h"
#include "nvVideoEffects.h"
#include "vfg_params.h"

// Referenced by nvVideoEffectsProxy.cpp: directory the proxy passes to SetDllDirectory.
char* g_nvVFXSDKPath = nullptr;

namespace {

struct Options {
  unsigned width = 0, height = 0;
  unsigned multiplier = 2;
  std::vector<float> timesteps;  // non-empty => timestep mode
  unsigned mode = VFG_MODE_MEDIUM;
  bool autoShotChange = true;
  int logLevel = NVCV_LOG_ERROR;
  std::string sdkRoot;
  bool check = false;
  bool onlyGenerated = false;
};

bool StartsWith(const char* s, const char* prefix, const char** value) {
  size_t n = strlen(prefix);
  if (strncmp(s, prefix, n) != 0) return false;
  *value = s + n;
  return true;
}

void Usage() {
  fprintf(stderr,
          "vfgpipe --sdk=<VideoFX root> --width=W --height=H [options]  < frames.bgr24 > out.bgr24\n"
          "  --multiplier=N        2..8, inserts N-1 frames per input pair (default 2)\n"
          "  --timesteps=a,b,c     explicit positions in (0,1) instead of --multiplier\n"
          "  --mode=low|medium|high   (default medium)\n"
          "  --shot-change=0|1     automatic shot-change detection (default 1)\n"
          "  --log-level=0..3      SDK log level (default 1)\n"
          "  --only-generated      write only the generated frames (no passthrough of the input frames)\n"
          "  --check               load the effect on a 640x360 dummy and exit (health check)\n");
}

bool ParseArgs(int argc, char** argv, Options* o) {
  for (int i = 1; i < argc; ++i) {
    const char* a = argv[i];
    const char* v = nullptr;
    if (StartsWith(a, "--sdk=", &v)) o->sdkRoot = v;
    else if (StartsWith(a, "--width=", &v)) o->width = (unsigned)strtoul(v, nullptr, 10);
    else if (StartsWith(a, "--height=", &v)) o->height = (unsigned)strtoul(v, nullptr, 10);
    else if (StartsWith(a, "--multiplier=", &v)) o->multiplier = (unsigned)strtoul(v, nullptr, 10);
    else if (StartsWith(a, "--timesteps=", &v)) {
      std::string s(v);
      size_t pos = 0;
      while (pos <= s.size()) {
        size_t comma = s.find(',', pos);
        if (comma == std::string::npos) comma = s.size();
        std::string tok = s.substr(pos, comma - pos);
        if (!tok.empty()) {
          char* end = nullptr;
          float t = strtof(tok.c_str(), &end);
          if (end != tok.c_str() + tok.size() || !(t > 0.f && t < 1.f)) {
            fprintf(stderr, "VFGERROR bad timestep '%s' (must be in (0,1))\n", tok.c_str());
            return false;
          }
          o->timesteps.push_back(t);
        }
        pos = comma + 1;
      }
    } else if (StartsWith(a, "--mode=", &v)) {
      if (!strcmp(v, "low")) o->mode = VFG_MODE_LOW;
      else if (!strcmp(v, "medium")) o->mode = VFG_MODE_MEDIUM;
      else if (!strcmp(v, "high")) o->mode = VFG_MODE_HIGH;
      else { fprintf(stderr, "VFGERROR bad --mode '%s'\n", v); return false; }
    } else if (StartsWith(a, "--shot-change=", &v)) o->autoShotChange = atoi(v) != 0;
    else if (StartsWith(a, "--log-level=", &v)) o->logLevel = atoi(v);
    else if (!strcmp(a, "--check")) o->check = true;
    else if (!strcmp(a, "--only-generated")) o->onlyGenerated = true;
    else if (!strcmp(a, "--help") || !strcmp(a, "-h")) { Usage(); exit(0); }
    else { fprintf(stderr, "VFGERROR unknown argument '%s'\n", a); return false; }
  }
  if (o->check) { o->width = 640; o->height = 360; }
  if (o->sdkRoot.empty()) {
    const char* env = getenv("VFX_SDK_ROOT");
    if (env) o->sdkRoot = env;
  }
  if (o->sdkRoot.empty()) { fprintf(stderr, "VFGERROR --sdk=<VideoFX root> (or VFX_SDK_ROOT) is required\n"); return false; }
  if (!o->width || !o->height) { fprintf(stderr, "VFGERROR --width and --height are required\n"); return false; }
  if (o->timesteps.empty() && (o->multiplier < 2 || o->multiplier > 8)) {
    fprintf(stderr, "VFGERROR --multiplier must be in 2..8\n");
    return false;
  }
  return true;
}

// Make the SDK DLLs (core + VFG feature + their dependencies) resolvable.
void SetupSdkPaths(const std::string& root) {
  static std::string coreBin;
  coreBin = root + "\\bin";
  g_nvVFXSDKPath = const_cast<char*>(coreBin.c_str());
  std::string path = coreBin + ";" + root + "\\features\\nvvfxvideoframegeneration\\bin;";
  if (const char* old = getenv("PATH")) path += old;
  SetEnvironmentVariableA("PATH", path.c_str());
}

bool ReadExact(FILE* f, unsigned char* dst, size_t n) {
  size_t got = 0;
  while (got < n) {
    size_t r = fread(dst + got, 1, n - got, f);
    if (r == 0) return false;
    got += r;
  }
  return true;
}

bool WriteExact(FILE* f, const unsigned char* src, size_t n) { return fwrite(src, 1, n, f) == n; }

#define VFX_CHECK(call)                                                                       \
  do {                                                                                        \
    NvCV_Status s_ = (call);                                                                  \
    if (s_ != NVCV_SUCCESS) {                                                                 \
      fprintf(stderr, "VFGERROR %s failed: %s (%d)\n", #call, NvCV_GetErrorStringFromCode(s_), (int)s_); \
      return 1;                                                                               \
    }                                                                                         \
  } while (0)

int Run(const Options& o) {
  const unsigned W = o.width, H = o.height;
  const size_t frameBytes = (size_t)W * H * 3;
  const bool timestepMode = !o.timesteps.empty();
  const unsigned numIntermediates = timestepMode ? (unsigned)o.timesteps.size() : o.multiplier - 1;
  struct CUstream_st* stream = nullptr;

  VFX_CHECK(NvVFX_ConfigureLogger(o.logLevel, "stderr", nullptr, nullptr));

  NvVFX_Handle eff = nullptr;
  VFX_CHECK(NvVFX_CreateEffect(VFG_EFFECT_NAME, &eff));

  // Host frames (BGR24) + wrappers.
  std::vector<unsigned char> hostBuf[2] = {std::vector<unsigned char>(frameBytes), std::vector<unsigned char>(frameBytes)};
  std::vector<unsigned char> hostOut(frameBytes);
  NvCVImage hostImg[2], hostOutImg;
  VFX_CHECK(NvCVImage_Init(&hostImg[0], W, H, (int)(W * 3), hostBuf[0].data(), NVCV_BGR, NVCV_U8, NVCV_CHUNKY, NVCV_CPU));
  VFX_CHECK(NvCVImage_Init(&hostImg[1], W, H, (int)(W * 3), hostBuf[1].data(), NVCV_BGR, NVCV_U8, NVCV_CHUNKY, NVCV_CPU));
  VFX_CHECK(NvCVImage_Init(&hostOutImg, W, H, (int)(W * 3), hostOut.data(), NVCV_BGR, NVCV_U8, NVCV_CHUNKY, NVCV_CPU));

  // GPU frames (RGBA8) ping-pong for the input pair, one for the output, one temp for BGR<->RGBA conversion.
  NvCVImage gpu[2], gpuOut, tmp;
  VFX_CHECK(NvCVImage_Alloc(&gpu[0], W, H, NVCV_RGBA, NVCV_U8, NVCV_CHUNKY, NVCV_GPU, 32));
  VFX_CHECK(NvCVImage_Alloc(&gpu[1], W, H, NVCV_RGBA, NVCV_U8, NVCV_CHUNKY, NVCV_GPU, 32));
  VFX_CHECK(NvCVImage_Alloc(&gpuOut, W, H, NVCV_RGBA, NVCV_U8, NVCV_CHUNKY, NVCV_GPU, 32));
  VFX_CHECK(NvCVImage_Alloc(&tmp, W, H, NVCV_BGR, NVCV_U8, NVCV_CHUNKY, NVCV_GPU, 0));

  VFX_CHECK(NvVFX_SetCudaStream(eff, NVVFX_CUDA_STREAM, stream));
  VFX_CHECK(NvVFX_SetU32(eff, NVVFX_INPUT_WIDTH, W));
  VFX_CHECK(NvVFX_SetU32(eff, NVVFX_INPUT_HEIGHT, H));
  VFX_CHECK(NvVFX_SetU32(eff, VFG_PARAM_MODE, o.mode));
  VFX_CHECK(NvVFX_SetU32(eff, VFG_PARAM_AUTO_SHOT_CHANGE, o.autoShotChange ? 1u : 0u));
  VFX_CHECK(NvVFX_Load(eff));
  VFX_CHECK(NvVFX_SetImage(eff, NVVFX_OUTPUT_IMAGE, &gpuOut));
  // Multiplier 0 = explicit timestep mode.
  VFX_CHECK(NvVFX_SetU32(eff, VFG_PARAM_FRAME_MULTIPLIER, timestepMode ? 0u : o.multiplier));

  fprintf(stderr, "VFGREADY\n");
  fflush(stderr);
  if (o.check) {
    NvVFX_DestroyEffect(eff);
    return 0;
  }

  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  static char inBuf[1 << 20], outBuf[1 << 20];
  setvbuf(stdin, inBuf, _IOFBF, sizeof(inBuf));
  setvbuf(stdout, outBuf, _IOFBF, sizeof(outBuf));

  unsigned prev = 0, cur = 1;
  unsigned long long framesIn = 0, framesOut = 0;

  // First frame: pass through and upload as "previous".
  if (!ReadExact(stdin, hostBuf[prev].data(), frameBytes)) {
    fprintf(stderr, "VFGDONE 0 0\n");
    NvVFX_DestroyEffect(eff);
    return 0;
  }
  ++framesIn;
  if (!o.onlyGenerated) {
    if (!WriteExact(stdout, hostBuf[prev].data(), frameBytes)) { fprintf(stderr, "VFGERROR stdout closed\n"); return 2; }
    ++framesOut;
  }
  VFX_CHECK(NvCVImage_Transfer(&hostImg[prev], &gpu[prev], 1.f, stream, &tmp));

  while (ReadExact(stdin, hostBuf[cur].data(), frameBytes)) {
    ++framesIn;
    VFX_CHECK(NvCVImage_Transfer(&hostImg[cur], &gpu[cur], 1.f, stream, &tmp));
    // VFG needs SetImage on BOTH inputs at the start of every new pair, even if pointers are unchanged.
    VFX_CHECK(NvVFX_SetImage(eff, NVVFX_INPUT_IMAGE_0, &gpu[prev]));
    VFX_CHECK(NvVFX_SetImage(eff, NVVFX_INPUT_IMAGE_1, &gpu[cur]));
    VFX_CHECK(NvVFX_SetU32(eff, VFG_PARAM_SHOT_CHANGE, 0u));

    for (unsigned k = 0; k < numIntermediates; ++k) {
      if (timestepMode) VFX_CHECK(NvVFX_SetF32(eff, VFG_PARAM_TIMESTEP, o.timesteps[k]));
      else VFX_CHECK(NvVFX_SetU32(eff, VFG_PARAM_FRAME_INDEX, k + 1u));
      VFX_CHECK(NvVFX_Run(eff, 0));
      VFX_CHECK(NvCVImage_Transfer(&gpuOut, &hostOutImg, 1.f, stream, &tmp));
      if (!WriteExact(stdout, hostOut.data(), frameBytes)) { fprintf(stderr, "VFGERROR stdout closed\n"); return 2; }
      ++framesOut;
      if (o.onlyGenerated) fflush(stdout);   // live: hand each generated frame on as soon as it exists
    }
    if (!o.onlyGenerated) {
      if (!WriteExact(stdout, hostBuf[cur].data(), frameBytes)) { fprintf(stderr, "VFGERROR stdout closed\n"); return 2; }
      ++framesOut;
    }
    fflush(stdout);   // live use: never leave a finished pair sitting in the CRT buffer

    std::swap(prev, cur);
    if ((framesIn & 7u) == 0) {
      fprintf(stderr, "VFGPROGRESS %llu\n", framesIn);
      fflush(stderr);
    }
  }

  fflush(stdout);
  fprintf(stderr, "VFGDONE %llu %llu\n", framesIn, framesOut);
  fflush(stderr);
  NvVFX_DestroyEffect(eff);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  Options o;
  if (!ParseArgs(argc, argv, &o)) {
    Usage();
    return 64;
  }
  SetupSdkPaths(o.sdkRoot);
  return Run(o);
}
