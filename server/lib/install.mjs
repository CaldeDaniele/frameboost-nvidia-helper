// Per-user installation: copy the exe, write vfgpipe.exe from the embedded asset, config.json, register the native host.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { INSTALL_DIR, IS_SEA, STORE_EXTENSION_ID, VERSION } from './config.mjs';
import { getAsset } from './assets.mjs';
import { registerNativeHost, unregisterNativeHost } from './registry.mjs';
import { run } from './health.mjs';

/** Copy over a possibly running exe: Windows allows renaming it even while it is locked. */
function replaceFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.copyFileSync(src, dest);
  } catch (e) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
    try { fs.rmSync(`${dest}.old`, { force: true }); } catch { /* ignore */ }
    fs.renameSync(dest, `${dest}.old`);
    fs.copyFileSync(src, dest);
  }
}
function writeAsset(name, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const data = getAsset(name);
  try {
    fs.writeFileSync(dest, data);
  } catch (e) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
    try { fs.rmSync(`${dest}.old`, { force: true }); } catch { /* ignore */ }
    fs.renameSync(dest, `${dest}.old`);
    fs.writeFileSync(dest, data);
  }
}

/**
 * @param {object} o
 * @param {string[]} o.allowedIds   extra extension ids (developer builds) besides the Web Store one
 * @param {string} o.sdkRoot        where the VFX SDK Core lives
 * @param {string} o.ffmpegPath     ffmpeg executable to use
 * @param {(step: string, status: 'running'|'ok'|'fail', detail?: string) => void} o.onStep
 */
export async function installHelper({ allowedIds = [], sdkRoot, ffmpegPath, onStep = () => {} }) {
  if (!IS_SEA) throw new Error('Installing is only available from the packaged FrameBoost-NVIDIA-Setup.exe');
  const dir = INSTALL_DIR;
  const exe = path.join(dir, 'frameboost-helper.exe');

  onStep('files', 'running');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(exe).toLowerCase()) replaceFile(process.execPath, exe);
  writeAsset('vfgpipe.exe', path.join(dir, 'bin', 'vfgpipe.exe'));
  for (const n of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) { try { writeAsset(n, path.join(dir, n)); } catch { /* optional */ } }
  onStep('files', 'ok');

  onStep('config', 'running');
  const ids = [...new Set([STORE_EXTENSION_ID, ...allowedIds])];
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: VERSION, sdkRoot, ffmpeg: ffmpegPath, allowedExtensionIds: ids }, null, 2));
  onStep('config', 'ok');

  onStep('register', 'running');
  const reg = registerNativeHost({ exePath: exe, allowedIds: ids });
  if (!reg.registered.length) {
    onStep('register', 'fail', 'No supported browser (Chrome, Brave, Edge, Chromium) was found for this user.');
    throw new Error('no browser to register the helper for');
  }
  onStep('register', 'ok', reg.registered.join(', '));

  onStep('check', 'running');
  let report = null;
  try {
    const { stdout } = await run(exe, ['--check'], 90000);
    report = JSON.parse(stdout.trim().split(/\r?\n/).pop());
  } catch (e) {
    onStep('check', 'fail', `The installed helper did not start: ${e && e.message || e}`);
    throw e;
  }
  onStep('check', report.problems.length ? 'fail' : 'ok', report.problems.join(' | '));
  return { installDir: dir, exe, registered: reg.registered, failed: reg.failed, report };
}

/** Remove the registry keys and the install folder (the running exe is deleted by a detached cmd after we exit). */
export function uninstallHelper() {
  const removed = unregisterNativeHost();
  const dir = INSTALL_DIR;
  if (fs.existsSync(dir)) {
    const cmd = `ping -n 4 127.0.0.1 >nul & rmdir /s /q "${dir}"`;
    spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  }
  return { removedFrom: removed, installDir: dir };
}
