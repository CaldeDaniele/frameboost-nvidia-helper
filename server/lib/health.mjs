import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

function sdkVersion(sdkRoot) {
  try {
    const h = fs.readFileSync(path.join(sdkRoot, 'videofx_version.h'), 'utf8');
    const n = (k) => new RegExp(`NVIDIA_VIDEOEFFECTS_SDK_VERSION_${k}\\s+(\\d+)`).exec(h)?.[1];
    return [n('MAJOR'), n('MINOR'), n('RELEASE'), n('BUILD')].join('.');
  } catch {
    return 'unknown';
  }
}

/** Everything the helper needs, checked once at startup. `problems` is empty when sessions can run. */
export async function checkEnvironment(cfg) {
  const env = { gpu: null, driver: null, sdk: sdkVersion(cfg.sdkRoot), ffmpeg: null, nvenc: false, problems: [] };
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], 8000);
    [env.gpu, env.driver] = stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
  } catch {
    env.problems.push('No NVIDIA GPU / driver found (nvidia-smi failed).');
  }
  try {
    const { stdout } = await run(cfg.ffmpeg, ['-hide_banner', '-encoders'], 10000);
    env.ffmpeg = true;
    env.nvenc = /\bh264_nvenc\b/.test(stdout);
    if (!env.nvenc) env.problems.push('ffmpeg has no h264_nvenc encoder.');
  } catch {
    env.problems.push(`ffmpeg not found (looked for "${cfg.ffmpeg}").`);
  }
  if (!fs.existsSync(cfg.vfgpipe)) {
    env.problems.push(`vfgpipe.exe missing at ${cfg.vfgpipe} (run scripts\\build.ps1).`);
  } else {
    try {
      const { stderr } = await run(cfg.vfgpipe, [`--sdk=${cfg.sdkRoot}`, '--check'], 60000);
      if (!stderr.includes('VFGREADY')) env.problems.push('Frame generation self-check gave no result.');
    } catch (e) {
      const last = (e.stderr || e.message || '').toString().trim().split(/\r?\n/).filter(Boolean).pop();
      env.problems.push(`Frame generation self-check failed: ${last}`);
    }
  }
  return env;
}
