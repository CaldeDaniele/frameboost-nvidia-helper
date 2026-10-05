import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function run(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; err.stdout = stdout; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

export function sdkVersion(sdkRoot) {
  try {
    const h = fs.readFileSync(path.join(sdkRoot, 'videofx_version.h'), 'utf8');
    const n = (k) => new RegExp(`NVIDIA_VIDEOEFFECTS_SDK_VERSION_${k}\\s+(\\d+)`).exec(h)?.[1];
    return [n('MAJOR'), n('MINOR'), n('RELEASE'), n('BUILD')].join('.');
  } catch {
    return 'unknown';
  }
}

/** Are the NVIDIA Core DLLs and the Video Frame Generation feature on disk? */
export function sdkFiles(sdkRoot) {
  const core = fs.existsSync(path.join(sdkRoot, 'bin', 'NVVideoEffects.dll'));
  const feature = fs.existsSync(path.join(sdkRoot, 'features', 'nvvfxvideoframegeneration', 'bin', 'nvVFXVideoFrameGeneration.dll'));
  return { core, feature, ready: core && feature };
}

/**
 * Everything the helper needs, checked once at startup. `problems` is empty when sessions can run; the strings are meant to be
 * read by the user (the extension shows them), so they say what to do.
 */
export async function checkEnvironment(cfg) {
  const env = { gpu: null, driver: null, computeCap: null, sdk: sdkVersion(cfg.sdkRoot), ffmpeg: null, x264: false, nvenc: false, problems: [] };
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], 8000);
    [env.gpu, env.driver] = stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
  } catch {
    env.problems.push('No NVIDIA graphics card or driver was found.');
  }
  try {
    const { stdout } = await run(cfg.ffmpeg, ['-hide_banner', '-encoders'], 10000);
    env.ffmpeg = true;
    env.nvenc = /\bh264_nvenc\b/.test(stdout);
    env.x264 = /\blibx264\b/.test(stdout);
    if (cfg.encoder === 'nvenc' ? !env.nvenc : !env.x264) env.problems.push('FFmpeg is installed but cannot encode H.264 (libx264 missing). Run the FrameBoost NVIDIA installer again.');
  } catch {
    env.problems.push('FFmpeg is missing. Run the FrameBoost NVIDIA installer again.');
  }
  const files = sdkFiles(cfg.sdkRoot);
  if (!files.ready) env.problems.push('The NVIDIA components (Video Effects SDK) are not installed yet. Finish the step "NVIDIA components" in the installer.');
  if (!fs.existsSync(cfg.vfgpipe)) {
    env.problems.push('Helper files are incomplete (vfgpipe.exe missing). Run the FrameBoost NVIDIA installer again.');
  } else if (files.ready) {
    try {
      const { stderr } = await run(cfg.vfgpipe, [`--sdk=${cfg.sdkRoot}`, '--check'], 60000);
      if (!stderr.includes('VFGREADY')) env.problems.push('The NVIDIA frame generation self-check gave no result.');
    } catch (e) {
      const last = (e.stderr || e.message || '').toString().trim().split(/\r?\n/).filter(Boolean).pop();
      env.problems.push(`The NVIDIA frame generation self-check failed: ${last}`);
    }
  }
  return env;
}
