// Native messaging host: started by the browser when the FrameBoost extension calls connectNative().
//   stdio framing: 4-byte little-endian length + UTF-8 JSON.
//   H->E {"t":"ready", port, token, ...}  once the loopback WebSocket server is listening (random port, token per start)
//   E->H {"t":"ping"} -> {"t":"pong"} ;  {"t":"quit"} -> exit.  stdin closing (port closed / browser quit) also ends us.
// stdout is the protocol channel: everything we log goes to logs/host.log instead.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, VERSION, loadConfig } from './lib/config.mjs';
import { checkEnvironment } from './lib/health.mjs';
import { createLiveServer } from './lib/wsserver.mjs';

const MAX_LOG = 512 * 1024;

export async function runNativeHost(originArg) {
  const origin = String(originArg || '').replace(/\/+$/, '');
  const logFile = path.join(ROOT, 'logs', 'host.log');
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG) fs.renameSync(logFile, `${logFile}.old`);
  } catch { /* logging is best effort */ }
  const log = (...a) => {
    try { fs.appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`); } catch { /* ignore */ }
  };
  console.log = console.info = console.warn = console.error = log;   // never write to stdout: it is the protocol channel
  log(`native host v${VERSION} started for ${origin}`);

  const send = (obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([hdr, body]));
  };

  let srv = null;
  let closing = false;
  const shutdown = (why) => {
    if (closing) return;
    closing = true;
    log(`shutdown: ${why}`);
    try { srv && srv.close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 150);
  };

  // Chrome closes our stdin when the extension disconnects or the browser exits.
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (n > 1024 * 1024) { shutdown('oversized message'); return; }
      if (buf.length < 4 + n) break;
      let msg = null;
      try { msg = JSON.parse(buf.subarray(4, 4 + n).toString('utf8')); } catch { /* ignore garbage */ }
      buf = buf.subarray(4 + n);
      if (!msg) continue;
      if (msg.t === 'ping') send({ t: 'pong' });
      else if (msg.t === 'quit') shutdown('quit requested');
    }
  });
  process.stdin.on('end', () => shutdown('stdin closed'));
  process.stdin.on('close', () => shutdown('stdin closed'));
  process.stdin.on('error', () => shutdown('stdin error'));
  process.stdin.resume();

  const cfg = loadConfig();
  let env;
  try {
    env = await checkEnvironment(cfg);
  } catch (e) {
    env = { gpu: null, driver: null, sdk: 'unknown', problems: [`The helper could not check this PC: ${e && e.message || e}`] };
  }
  if (closing) return;
  const token = crypto.randomBytes(16).toString('hex');
  srv = createLiveServer({
    cfg, env, token, statusPage: false, log,
    // Only the extension that started us may connect (Chrome already enforced allowed_origins at launch).
    originAllowed: (o) => o === origin,
  });
  let port;
  try {
    port = await srv.listen(0);
  } catch (e) {
    log('listen failed', String(e));
    send({ t: 'ready', v: 1, helper: VERSION, port: 0, token: '', gpu: env.gpu, driver: env.driver, sdk: env.sdk, maxMultiplier: 8, problems: [`The helper could not open its local port: ${e && e.message || e}`] });
    return;
  }
  log(`ready on 127.0.0.1:${port} problems=${JSON.stringify(env.problems)}`);
  send({ t: 'ready', v: 1, helper: VERSION, port, token, gpu: env.gpu, driver: env.driver, sdk: env.sdk, maxMultiplier: 8, problems: env.problems });
}
