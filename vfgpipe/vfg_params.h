// Parameter names of NVIDIA Maxine's "VideoFrameGeneration" effect, as used through the public NvVFX_Set* API.
// They are plain API identifiers (strings); defined here so this project does not need to copy or include
// NVIDIA's feature header (nvVFXVideoFrameGeneration.h, which ships under NVIDIA's own license with the feature).
#pragma once

#define VFG_EFFECT_NAME "VideoFrameGeneration"

#define VFG_PARAM_FRAME_MULTIPLIER "FrameMultiplier"     // 2..8 uniform, or 0 = explicit timesteps
#define VFG_PARAM_FRAME_INDEX "FrameIndex"               // 1..M-1 (multiplier mode)
#define VFG_PARAM_TIMESTEP "Timestep"                    // (0,1) (timestep mode)
#define VFG_PARAM_SHOT_CHANGE "ShotChange"               // 1 = the next pair is a scene cut
#define VFG_PARAM_AUTO_SHOT_CHANGE "AutomaticShotChangeDetectionEnabled"
#define VFG_PARAM_MODE "Mode"

#define VFG_MODE_LOW 0u
#define VFG_MODE_MEDIUM 1u
#define VFG_MODE_HIGH 2u
