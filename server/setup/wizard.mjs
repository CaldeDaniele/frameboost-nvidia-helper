// Installer wizard: a local web page (127.0.0.1, one-time token) that checks the PC, gets FFmpeg and the NVIDIA components,
// installs the helper per user and registers it as a native messaging host.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { INSTALL_DIR, IS_SEA, ROOT, VERSION } from '../lib/config.mjs';
import { getAsset } from '../lib/assets.mjs';
import { checkSystem, findFfmpeg, findExistingSdk, scanForSdkZips, downloadsDir } from '../lib/sysinfo.mjs';
import { downloadFile, fetchText, sha256File, extractZip, findFile } from '../lib/download.mjs';
import { sdkFiles } from '../lib/health.mjs';
import { detectBrowsers } from '../lib/registry.mjs';
import { installHelper, uninstallHelper } from '../lib/install.mjs';

const FFMPEG_SOURCES = [
  { name: 'gyan.dev (release essentials)', url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', hashUrl: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256' },
  { name: 'BtbN (GitHub)', url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', hashUrl: null },
];
const NGC_PAGES = [
  'https://catalog.ngc.nvidia.com/orgs/nvidia/maxine/resources/vfx_sdk_core',
  'https://catalog.ngc.nvidia.com/orgs/nvidia/maxine/models/nvvfxvideoframegeneration',
];

export function openUrl(url) {
  spawn('cmd.exe', ['/d', '/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
}

export async function runWizard({ open = true, port = 0, onListening } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const startedAt = Date.now();
  let lastRequest = Date.now();
  let shuttingDown = false;

  const state = {
    version: VERSION,
    installDir: INSTALL_DIR,
    system: { status: 'running', gpu: null, driver: null, computeCap: null, ok: false, reasons: [] },
    ffmpeg: { status: 'idle', path: null, source: null, received: 0, total: 0, error: null },
    sdk: { status: 'waiting', root: null, version: null, core: null, feature: null, wrong: [], watching: [...new Set([downloadsDir(), ...(IS_SEA ? [ROOT] : [])])], error: null, extractingSince: 0 },
    install: { status: 'idle', steps: [], error: null, registered: [], browsers: detectBrowsers(), report: null },
    allowedIds: [],
    log: [],
  };
  const log = (m) => { state.log.push(`${new Date().toISOString().slice(11, 19)} ${m}`); if (state.log.length > 80) state.log.shift(); console.log(m); };

  // ------------------------------------------------------------ system + ffmpeg + sdk detection
  const refreshSystem = async () => {
    state.system.status = 'running';
    try { Object.assign(state.system, await checkSystem()); } catch (e) { state.system.reasons = [String(e && e.message || e)]; state.system.ok = false; }
    state.system.status = 'done';
  };
  const refreshFfmpeg = async () => {
    const f = await findFfmpeg();
    if (f) Object.assign(state.ffmpeg, { status: 'ok', path: f.path, source: f.source, error: null });
    else if (!['downloading', 'extracting'].includes(state.ffmpeg.status)) state.ffmpeg.status = 'missing';
  };
  const refreshSdkExisting = () => {
    const ex = findExistingSdk();
    if (ex) Object.assign(state.sdk, { status: 'ok', root: ex.root, version: ex.version, error: null });
    return !!ex;
  };

  async function downloadFfmpeg() {
    if (['downloading', 'extracting'].includes(state.ffmpeg.status)) return;
    const f = state.ffmpeg;
    f.status = 'downloading'; f.error = null; f.received = 0; f.total = 0;
    const tmp = path.join(INSTALL_DIR, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const zip = path.join(tmp, 'ffmpeg.zip');
    let lastErr = null;
    for (const src of FFMPEG_SOURCES) {
      try {
        log(`downloading FFmpeg from ${src.name}`);
        await downloadFile(src.url, zip, ({ received, total }) => { f.received = received; f.total = total; });
        if (src.hashUrl) {
          const want = (await fetchText(src.hashUrl)).split(/\s+/)[0].toLowerCase();
          const got = await sha256File(zip);
          if (want && want !== got) throw new Error('the downloaded FFmpeg did not match its published SHA-256');
          log('FFmpeg checksum verified');
        }
        f.status = 'extracting';
        const x = path.join(tmp, 'ffmpeg-x');
        fs.rmSync(x, { recursive: true, force: true });
        await extractZip(zip, x);
        const exe = findFile(x, 'ffmpeg.exe');
        if (!exe) throw new Error('ffmpeg.exe not found in the archive');
        const dest = path.join(INSTALL_DIR, 'ffmpeg');
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(exe, path.join(dest, 'ffmpeg.exe'));
        for (const n of ['LICENSE', 'README.txt']) { const p = findFile(x, n, 2); if (p) fs.copyFileSync(p, path.join(dest, `FFMPEG_${n}`)); }   // GPL notice travels with the binary
        fs.rmSync(tmp, { recursive: true, force: true });
        await refreshFfmpeg();
        if (state.ffmpeg.status !== 'ok') throw new Error('the downloaded FFmpeg cannot encode H.264 (libx264)');
        log('FFmpeg installed');
        return;
      } catch (e) {
        lastErr = e; log(`FFmpeg from ${src.name} failed: ${e && e.message || e}`);
      }
    }
    f.status = 'failed'; f.error = String(lastErr && lastErr.message || lastErr);
  }

  // Watch Downloads for the two NGC files; extract when both are complete and stable.
  const seen = new Map();   // path -> {size, since}
  let extracting = false;
  async function sdkTick() {
    const s = state.sdk;
    if (s.status === 'ok' || extracting || shuttingDown) return;
    const found = scanForSdkZips(s.watching);
    s.wrong = found.wrong.map((w) => ({ name: w.name, platform: w.platform }));
    for (const k of ['core', 'feature']) {
      const c = found[k];
      if (!c) { s[k] = null; continue; }
      const prev = seen.get(c.path);
      if (!prev || prev.size !== c.size) seen.set(c.path, { size: c.size, since: Date.now() });
      const stable = Date.now() - seen.get(c.path).since > 3000;
      s[k] = { name: path.basename(c.path), size: c.size, complete: c.complete && stable };
    }
    if (s[ 'core' ] && s.feature && s.core.complete && s.feature.complete) {
      extracting = true; s.status = 'extracting'; s.extractingSince = Date.now(); s.error = null;
      try {
        const root = path.join(INSTALL_DIR, 'sdk', 'core');
        log('extracting the NVIDIA SDK Core (about 1 GB, this takes a minute)');
        await extractZip(found.core.path, root);
        log('extracting the Video Frame Generation feature');
        await extractZip(found.feature.path, path.join(root, 'VideoFX', 'features'));
        const r = path.join(root, 'VideoFX');
        if (!sdkFiles(r).ready) throw new Error('the NVIDIA files were extracted but the expected DLLs are missing: are these the Windows 1.3 packages?');
        refreshSdkExisting();
        log('NVIDIA components installed');
      } catch (e) {
        s.status = 'failed'; s.error = String(e && e.message || e); log(`SDK extraction failed: ${s.error}`);
        setTimeout(() => { if (state.sdk.status === 'failed') state.sdk.status = 'waiting'; }, 15000);
      } finally { extracting = false; }
    } else if (s.core || s.feature) s.status = 'partial';
    else s.status = 'waiting';
  }

  async function doInstall(body) {
    const i = state.install;
    if (i.status === 'running') return;
    const ids = Array.isArray(body.allowedIds) ? body.allowedIds.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-p]{32}$/.test(x)) : [];
    state.allowedIds = ids;
    Object.assign(i, { status: 'running', steps: [], error: null, registered: [], report: null });
    try {
      const r = await installHelper({
        allowedIds: ids,
        sdkRoot: state.sdk.root,
        ffmpegPath: state.ffmpeg.path,
        onStep: (name, status, detail) => {
          const ex = i.steps.find((s) => s.name === name);
          if (ex) Object.assign(ex, { status, detail }); else i.steps.push({ name, status, detail });
        },
      });
      i.registered = r.registered; i.report = { problems: r.report.problems, gpu: r.report.gpu, sdk: r.report.sdk };
      i.status = r.report.problems.length ? 'fail' : 'ok';
      if (i.status === 'fail') i.error = r.report.problems.join(' ');
      log(`install ${i.status}: registered for ${r.registered.join(', ')}`);
    } catch (e) {
      i.status = 'fail'; i.error = String(e && e.message || e); log(`install failed: ${i.error}`);
    }
  }

  // ------------------------------------------------------------ HTTP
  let boundPort = 0;
  const hostOk = (req) => new RegExp(`^(127\\.0\\.0\\.1|localhost):${boundPort}$`).test(req.headers.host || '');
  const json = (res, code, body) => { const d = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(d) }); res.end(d); };
  const readBody = async (req) => {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 64 * 1024) throw new Error('body too large'); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
  };

  const server = http.createServer(async (req, res) => {
    lastRequest = Date.now();
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!hostOk(req)) return json(res, 403, { error: 'forbidden host' });
      const key = url.searchParams.get('k') || req.headers['x-setup-token'];
      if (key !== token) return json(res, 403, { error: 'This page can only be opened from the installer window.' });
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(getAsset('ui.html'));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { ...state, now: Date.now() });
      if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
      const body = await readBody(req);
      switch (url.pathname) {
        case '/api/recheck': await Promise.all([refreshSystem(), refreshFfmpeg()]); refreshSdkExisting(); return json(res, 200, { ok: true });
        case '/api/ffmpeg/download': downloadFfmpeg(); return json(res, 202, { ok: true });
        case '/api/sdk/open-ngc': NGC_PAGES.forEach(openUrl); return json(res, 200, { ok: true });
        case '/api/sdk/folder': {
          const p = String(body.path || '').trim().replace(/^"|"$/g, '');
          if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return json(res, 400, { error: 'That folder does not exist.' });
          if (!state.sdk.watching.includes(p)) state.sdk.watching.push(p);
          return json(res, 200, { ok: true });
        }
        case '/api/install': doInstall(body); return json(res, 202, { ok: true });
        case '/api/uninstall': { const r = uninstallHelper(); log(`uninstalled: ${JSON.stringify(r)}`); setTimeout(() => process.exit(0), 500); return json(res, 200, { ok: true, ...r }); }
        case '/api/quit': json(res, 200, { ok: true }); setTimeout(() => process.exit(0), 300); return;
        default: return json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: String(e && e.message || e) });
    }
  });

  boundPort = await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port)); });
  const url = `http://127.0.0.1:${boundPort}/?k=${token}`;

  // kick off the checks
  refreshSystem();
  refreshFfmpeg();
  refreshSdkExisting();
  const tick = setInterval(() => { sdkTick().catch((e) => log(`sdk watcher: ${e && e.message || e}`)); }, 2000);
  // leave when forgotten for an hour
  setInterval(() => { if (Date.now() - lastRequest > 60 * 60 * 1000) process.exit(0); }, 60 * 1000).unref();

  console.log(`\n  FrameBoost NVIDIA installer v${VERSION}\n  The installer page is at:\n    ${url}\n  Keep this window open until the page says "Done".\n`);
  if (open) openUrl(url);
  if (onListening) onListening({ url, port: boundPort, token, state, stop: () => { shuttingDown = true; clearInterval(tick); server.close(); } });
  return { url, port: boundPort, token, state, startedAt, stop: () => { shuttingDown = true; clearInterval(tick); server.close(); } };
}
