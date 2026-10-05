// Native messaging host registration (per user, HKCU: no administrator rights).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const HOST_NAME = 'com.frameboost.nvidia';
const LOCAL = process.env.LOCALAPPDATA || '';
// Brave and Edge read their own registry branch; Chrome's branch is used by Chrome only.
const BROWSERS = [
  { name: 'Chrome', key: 'Software\\Google\\Chrome', dir: path.join(LOCAL, 'Google', 'Chrome') },
  { name: 'Brave', key: 'Software\\BraveSoftware\\Brave-Browser', dir: path.join(LOCAL, 'BraveSoftware', 'Brave-Browser') },
  { name: 'Edge', key: 'Software\\Microsoft\\Edge', dir: path.join(LOCAL, 'Microsoft', 'Edge') },
  { name: 'Chromium', key: 'Software\\Chromium', dir: path.join(LOCAL, 'Chromium') },
];
const fullKey = (b) => `HKCU\\${b.key}\\NativeMessagingHosts\\${HOST_NAME}`;
const reg = (args) => spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8' });

/** Browsers that look installed for this user. */
export const detectBrowsers = () => BROWSERS.filter((b) => fs.existsSync(b.dir)).map((b) => b.name);

/** Is the host registered for this browser? */
export const isRegistered = (name) => {
  const b = BROWSERS.find((x) => x.name === name);
  return !!b && reg(['query', fullKey(b), '/ve']).status === 0;
};

export function registeredBrowsers() {
  return BROWSERS.filter((b) => reg(['query', fullKey(b), '/ve']).status === 0).map((b) => b.name);
}

/**
 * Write native-host.json next to the exe and point the browsers' registry keys at it.
 * @returns {{manifest: string, registered: string[], failed: string[]}}
 */
export function registerNativeHost({ exePath, allowedIds, browsers }) {
  const dir = path.dirname(exePath);
  const manifest = path.join(dir, 'native-host.json');
  const ids = [...new Set(allowedIds.filter((id) => /^[a-p]{32}$/.test(id)))];
  if (!ids.length) throw new Error('no valid extension id to allow');
  fs.writeFileSync(manifest, JSON.stringify({
    name: HOST_NAME,
    description: 'FrameBoost NVIDIA Frame Generation helper',
    path: exePath,
    type: 'stdio',
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  }, null, 2));
  const names = browsers && browsers.length ? browsers : detectBrowsers();
  const registered = [], failed = [];
  for (const n of names) {
    const b = BROWSERS.find((x) => x.name === n);
    if (!b) continue;
    const r = reg(['add', fullKey(b), '/ve', '/t', 'REG_SZ', '/d', manifest, '/f']);
    (r.status === 0 ? registered : failed).push(n);
  }
  return { manifest, registered, failed };
}

export function unregisterNativeHost() {
  const removed = [];
  for (const b of BROWSERS) if (reg(['delete', fullKey(b), '/f']).status === 0) removed.push(b.name);
  return removed;
}
