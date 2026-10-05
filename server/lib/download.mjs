import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Download `url` to `dest` following redirects; onProgress({received, total}). */
export async function downloadFile(url, dest, onProgress = () => {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${new URL(url).host}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let last = 0;
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => {
    received += c.length;
    const now = Date.now();
    if (now - last > 250) { last = now; onProgress({ received, total }); }
  });
  const part = `${dest}.part`;
  await pipeline(src, fs.createWriteStream(part));
  fs.renameSync(part, dest);
  onProgress({ received, total: total || received });
}

export async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
  return (await res.text()).trim();
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// The tar.exe of Windows 10/11 (bsdtar reads zip). Call it by full path: a GNU tar from Git for Windows earlier in PATH
// would read "C:\..." as a remote host.
export const WINDOWS_TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

/** Extract a zip with Windows' own tar. */
export function extractZip(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn(fs.existsSync(WINDOWS_TAR) ? WINDOWS_TAR : 'tar.exe', ['-xf', zip, '-C', destDir], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`could not extract ${path.basename(zip)}: ${err.trim().split('\n')[0] || 'tar exit ' + code}`))));
  });
}

/** Find a file by name below `dir` (depth-limited). */
export function findFile(dir, name, depth = 4) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return path.join(dir, e.name);
  if (depth > 0) for (const e of entries) if (e.isDirectory()) { const f = findFile(path.join(dir, e.name), name, depth - 1); if (f) return f; }
  return null;
}
