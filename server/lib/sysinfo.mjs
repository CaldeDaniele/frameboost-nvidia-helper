// System facts for the installer wizard: GPU/driver, ffmpeg, NVIDIA SDK locations.
import fs from 'node:fs';
import path from 'node:path';
import { run, sdkFiles, sdkVersion } from './health.mjs';
import { INSTALL_DIR } from './config.mjs';

const MIN_DRIVER = '570.65';
const MIN_COMPUTE_CAP = 8.9;   // Ada (8.9) and Blackwell (10.x/12.x)

const verNum = (v) => String(v || '').split('.').map((x) => parseInt(x, 10) || 0);
export function versionAtLeast(have, want) {
  const a = verNum(have), b = verNum(want);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** GPU name, driver and compute capability from nvidia-smi; verdict for Video Frame Generation. */
export async function checkSystem() {
  const out = { windows: process.platform === 'win32' && process.arch === 'x64', gpu: null, driver: null, computeCap: null, ok: false, reasons: [] };
  if (!out.windows) out.reasons.push('This installer is for 64-bit Windows.');
  try {
    let stdout;
    try {
      ({ stdout } = await run('nvidia-smi', ['--query-gpu=name,driver_version,compute_cap', '--format=csv,noheader'], 10000));
    } catch {
      ({ stdout } = await run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], 10000));   // older drivers
    }
    const [name, driver, cap] = stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
    out.gpu = name; out.driver = driver; out.computeCap = cap ? parseFloat(cap) : null;
  } catch {
    out.reasons.push('No NVIDIA graphics card or driver was found (nvidia-smi did not answer). Install the latest NVIDIA driver.');
  }
  if (out.gpu) {
    const capOk = out.computeCap != null ? out.computeCap >= MIN_COMPUTE_CAP : /RTX\s*(4|5)\d{3}|L40|RTX\s*[45]000/i.test(out.gpu);
    if (!capOk) out.reasons.push(`${out.gpu} is too old for NVIDIA Frame Generation: it needs an RTX 40 or RTX 50 series card.`);
    if (out.driver && !versionAtLeast(out.driver, MIN_DRIVER)) out.reasons.push(`The NVIDIA driver ${out.driver} is too old: version ${MIN_DRIVER} or newer is required. Update it from nvidia.com/drivers.`);
  }
  out.ok = out.windows && !!out.gpu && out.reasons.length === 0;
  return out;
}

/** An ffmpeg with libx264: one we installed, else the one in PATH. */
export async function findFfmpeg() {
  const candidates = [path.join(INSTALL_DIR, 'ffmpeg', 'ffmpeg.exe'), 'ffmpeg'];
  for (const exe of candidates) {
    try {
      const { stdout } = await run(exe, ['-hide_banner', '-encoders'], 10000);
      if (/\blibx264\b/.test(stdout)) {
        let full = exe;
        if (exe === 'ffmpeg') { try { full = (await run('where.exe', ['ffmpeg'], 5000)).stdout.split(/\r?\n/)[0].trim() || 'ffmpeg'; } catch { /* keep name */ } }
        return { path: full, source: exe === 'ffmpeg' ? 'path' : 'installed' };
      }
    } catch { /* try next */ }
  }
  return null;
}

/** An existing, complete SDK install we can reuse. */
export function findExistingSdk() {
  const roots = [path.join(INSTALL_DIR, 'sdk', 'core', 'VideoFX'), process.env.VFX_SDK_ROOT].filter(Boolean);
  for (const r of roots) {
    const f = sdkFiles(r);
    if (f.ready) return { root: r, version: sdkVersion(r) };
  }
  return null;
}

export const downloadsDir = () => path.join(process.env.USERPROFILE || '', 'Downloads');

const CORE_RE = /^VFXSDK_windows_1\.3\.\d+\.\d+( \(\d+\))?\.zip$/i;
const FEATURE_RE = /^1\.3\.\d+\.\d+_lib_windows( \(\d+\))?\.zip$/i;
// The same two packages for another platform (NGC offers e.g. "woa" = Windows on Arm next to "windows"): useless on this PC.
const OTHER_CORE_RE = /^VFXSDK_([a-z0-9]+)_1\.3\.\d+\.\d+( \(\d+\))?\.zip$/i;
const OTHER_FEATURE_RE = /^1\.3\.\d+\.\d+_lib_([a-z0-9]+)( \(\d+\))?\.zip$/i;

/** Is this a finished zip? (End-of-central-directory record present in the last 64 KB.) */
export function zipLooksComplete(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < 1024) return false;
    const len = Math.min(st.size, 70000);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    return buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0;
  } catch { return false; }
}

/** Look for the two NGC downloads in the given folders. */
export function scanForSdkZips(dirs) {
  const found = { core: null, feature: null, wrong: [] };
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const kind = CORE_RE.test(n) ? 'core' : FEATURE_RE.test(n) ? 'feature' : null;
      if (!kind) {
        const other = OTHER_CORE_RE.exec(n) || OTHER_FEATURE_RE.exec(n);
        if (other && other[1].toLowerCase() !== 'windows') found.wrong.push({ name: n, platform: other[1].toLowerCase(), dir });
        continue;
      }
      const p = path.join(dir, n);
      let st; try { st = fs.statSync(p); } catch { continue; }
      const minSize = kind === 'core' ? 500e6 : 50e6;
      const cur = found[kind];
      if (!cur || st.mtimeMs > cur.mtimeMs) found[kind] = { path: p, size: st.size, mtimeMs: st.mtimeMs, complete: st.size >= minSize && zipLooksComplete(p) };
    }
  }
  return found;
}
