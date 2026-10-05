// The live frame-generation server: WebSocket on 127.0.0.1 that turns H.264 from the extension into generated in-between
// frames (NVIDIA Maxine Video Frame Generation) and sends them back as H.264.  Shared by the manual `--serve` mode
// (fixed port, long-lived token, status page) and the native-messaging host (random port, per-start token, exact origin).
// Protocol: see the FrameBoost spec "NVIDIA Frame Generation backend (helper-backed)".
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { VERSION } from './config.mjs';
import { Chain } from './chain.mjs';

const MAX_PIXELS = 3840 * 2160;

const eq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * @param {object} o
 * @param {object} o.cfg                 helper configuration (ffmpeg, vfgpipe, sdkRoot, maxSessions, encoder…)
 * @param {object} o.env                 result of checkEnvironment(): gpu, driver, sdk, problems[]
 * @param {string} o.token               the secret a client must present in `hello`
 * @param {(origin: string) => boolean} o.originAllowed
 * @param {boolean} [o.statusPage]       serve a small status page showing the token (manual mode only)
 * @param {(...a: any[]) => void} [o.log]
 */
export function createLiveServer({ cfg, env, token, originAllowed, statusPage = false, log = () => {} }) {
  const sessions = new Set();   // live Chain objects (global limit)
  let port = 0;

  const hostOk = (req) => new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`).test(req.headers.host || '');

  const server = http.createServer((req, res) => {
    if (!hostOk(req)) { res.writeHead(403).end('forbidden'); return; }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: env.problems.length === 0, helper: VERSION, gpu: env.gpu, sdk: env.sdk, sessions: sessions.size }));
      return;
    }
    if (!statusPage) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><title>FrameBoost NVIDIA helper</title>
<body style="font:16px system-ui;max-width:640px;margin:48px auto;padding:0 16px;color:#222">
<h1 style="font-size:22px">FrameBoost NVIDIA helper <small style="color:#888">v${VERSION}</small></h1>
<p>${env.problems.length ? '<b style="color:#b42318">Not ready</b><ul>' + env.problems.map((p) => `<li>${p.replace(/</g, '&lt;')}</li>`).join('') + '</ul>' : '<b style="color:#0a7d33">Ready</b> — ' + env.gpu + ' · Maxine VFX SDK ' + env.sdk}</p>
<p>Pairing token — paste it in the FrameBoost popup (Engine → Advanced):</p>
<pre id="tok" style="font-size:20px;background:#f3f3f3;padding:12px;border-radius:8px;user-select:all">••••-••••-••••-••••</pre>
<button onclick="const t=document.getElementById('tok');const s=t.dataset.s!=='1';t.textContent=s?'${token}':'••••-••••-••••-••••';t.dataset.s=s?'1':'0';this.textContent=s?'Hide':'Show token'">Show token</button>
<p style="color:#666">Active sessions: ${sessions.size}. Only the FrameBoost extension on this computer can connect.</p>`);
  });

  const wss = new WebSocketServer({
    server,
    path: '/live',
    maxPayload: 8 * 1024 * 1024,
    verifyClient: ({ origin, req }) => hostOk(req) && !!origin && originAllowed(origin),
  });

  wss.on('connection', (ws, req) => {
    const peer = `${req.socket.remotePort}`;
    let authed = false;
    let session = null;            // { id, chain, statsTimer }
    const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
    const authTimer = setTimeout(() => { if (!authed) ws.close(4401, 'auth timeout'); }, 5000);

    function endSession(reason) {
      if (!session) return;
      clearInterval(session.statsTimer);
      session.chain.onExit = () => {};
      session.chain.stop();
      sessions.delete(session.chain);
      log(`[${peer}] session ${session.id} ended (${reason}); in=${session.chain.inAus} out=${session.chain.outAus} splitAnomalies=${session.chain.splitAnomalies}`);
      session = null;
    }

    async function startSession(m) {
      endSession('replaced');
      const id = m.id >>> 0;
      const W = m.width | 0, H = m.height | 0, M = m.multiplier | 0, fps = Math.round(Number(m.fps) || 0);
      const mode = ['low', 'medium', 'high'].includes(m.mode) ? m.mode : 'medium';
      const bad = (msg) => send({ t: 'error', id, msg });
      if (env.problems.length) return bad(`helper not ready: ${env.problems[0]}`);
      if (!(W >= 128 && H >= 96 && W % 2 === 0 && H % 2 === 0 && W * H <= MAX_PIXELS)) return bad(`unsupported size ${W}x${H}`);
      if (!(M >= 2 && M <= 8)) return bad('multiplier must be 2..8');
      if (!(fps >= 1 && fps <= 240)) return bad('fps must be 1..240');
      if (sessions.size >= cfg.maxSessions) return bad('helper busy (too many sessions)');

      const chain = new Chain({ width: W, height: H, fps, multiplier: M, mode }, cfg, (l) => log(`[${peer}]`, l));
      const s = { id, chain, statsTimer: null };
      sessions.add(chain);
      session = s;
      const hdr = Buffer.alloc(12);
      chain.onAu = (au, n) => {
        if (ws.readyState !== ws.OPEN || session !== s) return;
        hdr.writeUInt32LE(id, 0);
        hdr.writeUInt32LE(Math.floor(n / (M - 1)), 4);   // pair index
        hdr.writeUInt16LE((n % (M - 1)) + 1, 8);          // k = 1..M-1
        hdr.writeUInt16LE(M, 10);
        ws.send(Buffer.concat([hdr, au]), { binary: true });
      };
      chain.onExit = (why) => {
        if (session !== s) return;
        send({ t: 'error', id, msg: `pipeline stopped: ${why}` });
        endSession('pipeline exit');
      };
      try {
        await chain.start();
      } catch (e) {
        if (session === s) { send({ t: 'error', id, msg: e.message }); endSession('start failed'); }
        return;
      }
      if (session !== s) return;
      s.statsTimer = setInterval(() => send({ t: 'stats', id, inFrames: chain.inAus, outFrames: chain.outAus, pendingKB: Math.round(chain.pendingBytes / 1024) }), 1000);
      send({ t: 'started', id });
      log(`[${peer}] session ${id} started`);
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!authed || !session || data.length < 5) return;
        if (data.readUInt32LE(0) !== session.id) return;   // stale session
        session.chain.write(data.subarray(4));
        return;
      }
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.t === 'hello') {
        if (m.v !== 1) { send({ t: 'hello', ok: false, reason: 'unsupported protocol version' }); ws.close(); return; }
        if (!eq(m.token ?? '', token)) {
          log(`[${peer}] bad token`);
          send({ t: 'hello', ok: false, reason: 'bad token (pairing token rejected)' });
          ws.close();
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        send({ t: 'hello', ok: true, v: 1, helper: VERSION, gpu: env.gpu, sdk: env.sdk, maxMultiplier: 8, problems: env.problems });
        return;
      }
      if (!authed) return;
      if (m.t === 'start') startSession(m);
      else if (m.t === 'stop') endSession('stop');
    });

    ws.on('close', () => { clearTimeout(authTimer); endSession('socket closed'); });
    ws.on('error', () => { /* close follows */ });
  });

  return {
    server,
    /** Listen on 127.0.0.1 (port 0 = pick a free one). Resolves with the port. */
    listen(wantedPort = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantedPort, '127.0.0.1', () => { port = server.address().port; resolve(port); });
      });
    },
    sessionCount: () => sessions.size,
    /** Stop every pipeline and the server. */
    close() {
      for (const c of sessions) { c.onExit = () => {}; c.stop(); }
      sessions.clear();
      wss.clients.forEach((c) => { try { c.terminate(); } catch { /* gone */ } });
      server.close();
    },
  };
}
