// Protocol test: plays the part of the browser extension against a running helper.
// Encodes a video to H.264 Annex-B (like WebCodecs does), sends it at real-time pace, receives the generated frames,
// checks (pair, k) bookkeeping, measures latency, and writes the returned stream to <out>.h264 for inspection.
// usage: node scripts/protocol-test.mjs <video> [multiplier=2] [fps=60] [mode=medium] [out.h264]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { loadConfig, ROOT } from '../server/lib/config.mjs';

const [video, mArg, fpsArg, modeArg, outArg] = process.argv.slice(2);
if (!video) { console.error('usage: node scripts/protocol-test.mjs <video> [multiplier] [fps] [mode] [out.h264]'); process.exit(64); }
const M = Number(mArg || 2), FPS = Number(fpsArg || 60), MODE = modeArg || 'medium';
const OUT = outArg || path.join(ROOT, 'work', 'protocol-out.h264');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const cfg = loadConfig();

// 1) source frames as H.264 access units (AUD-delimited) + size
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', video]).toString());
const W = probe.streams[0].width & ~1, H = probe.streams[0].height & ~1;
const h264 = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video, '-an', '-vf', `scale=${W}:${H},fps=${FPS}`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-bf', '0', '-g', '60', '-x264-params', 'aud=1:annexb=1',
  '-f', 'h264', 'pipe:1'], { maxBuffer: 1 << 30 });
const starts = [];
for (let i = 0; i + 4 < h264.length; i++) if (h264[i] === 0 && h264[i + 1] === 0 && h264[i + 2] === 0 && h264[i + 3] === 1 && (h264[i + 4] & 0x1f) === 9) starts.push(i);
const aus = starts.map((s, i) => h264.subarray(s, starts[i + 1] ?? h264.length));
console.log(`source: ${aus.length} frames ${W}x${H} @${FPS} (${(h264.length / 1e6).toFixed(1)} MB H.264), multiplier x${M}, ${MODE}`);

// 2) talk to the helper
const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/live`, { headers: { Origin: 'chrome-extension://protocol-test' } });
ws.binaryType = 'nodebuffer';
const sentAt = [];                    // performance.now() when input frame i was sent
const got = new Map();                // pair -> { first, last, count }
const outStream = fs.createWriteStream(OUT);
let nOut = 0, bad = 0, helloReply = null, started = null;
const waitFor = (pred) => new Promise((resolve) => { waiters.push({ pred, resolve }); });
const waiters = [];
const settle = () => { for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred()) waiters.splice(i, 1)[0].resolve(); };

ws.on('message', (data, isBinary) => {
  const now = performance.now();
  if (!isBinary) {
    const m = JSON.parse(data.toString());
    if (m.t === 'hello') helloReply = m;
    else if (m.t === 'started') started = m;
    else if (m.t === 'error') { console.error('helper error:', m.msg); started = started || { error: m.msg }; }
    else if (m.t === 'stats' && process.env.VERBOSE) console.log('stats', JSON.stringify(m));
    settle();
    return;
  }
  const id = data.readUInt32LE(0), pair = data.readUInt32LE(4), k = data.readUInt16LE(8), mm = data.readUInt16LE(10);
  if (mm !== M || k < 1 || k >= M) bad++;
  const au = data.subarray(12);
  if (!(au[0] === 0 && au[1] === 0 && au[2] === 0 && au[3] === 1 && (au[4] & 0x1f) === 9)) bad++;   // must start with an AUD
  const g = got.get(pair) || { first: now, last: now, count: 0, ks: [] };
  g.last = now; g.count++; g.ks.push(k);
  got.set(pair, g);
  nOut++;
  outStream.write(au);
});
ws.on('close', () => { settle(); });
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

ws.send(JSON.stringify({ t: 'hello', v: 1, token: cfg.token }));
await waitFor(() => helloReply);
if (!helloReply.ok) { console.error('hello failed:', helloReply.reason); process.exit(1); }
console.log(`hello ok: ${helloReply.gpu} · SDK ${helloReply.sdk} · helper ${helloReply.helper}${helloReply.problems?.length ? ' · PROBLEMS: ' + helloReply.problems.join('; ') : ''}`);

const ID = 7;
const t0 = performance.now();
ws.send(JSON.stringify({ t: 'start', id: ID, width: W, height: H, fps: FPS, multiplier: M, mode: MODE }));
await waitFor(() => started);
if (started.error) process.exit(1);
console.log(`model loaded in ${((performance.now() - t0) / 1000).toFixed(2)} s`);

// 3) stream the frames at real-time pace
const idBuf = Buffer.alloc(4); idBuf.writeUInt32LE(ID);
const period = 1000 / FPS;
const start = performance.now() + 30;
for (let i = 0; i < aus.length; i++) {
  const due = start + i * period;
  const wait = due - performance.now();
  if (wait > 2) await new Promise((r) => setTimeout(r, wait - 1));
  while (performance.now() < due) { /* spin: exact pacing */ }
  sentAt[i] = performance.now();
  ws.send(Buffer.concat([idBuf, aus[i]]), { binary: true });
}
const expected = (aus.length - 1) * (M - 1);
const deadline = performance.now() + 5000;
while (nOut < expected && performance.now() < deadline) await new Promise((r) => setTimeout(r, 50));
ws.send(JSON.stringify({ t: 'stop', id: ID }));
await new Promise((r) => setTimeout(r, 200));
ws.close();
outStream.end();

// 4) report
const lat = [];
const byPair = [];
for (const [pair, g] of [...got].sort((a, b) => a[0] - b[0])) if (sentAt[pair + 1] != null) { const l = g.last - sentAt[pair + 1]; lat.push(l); byPair.push(Math.round(l)); }
if (process.env.TIMELINE) console.log('latency by pair (ms), every 5th:', byPair.filter((_, i) => i % 5 === 0).join(' '));
lat.sort((a, b) => a - b);
const pc = (p) => lat.length ? +lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(1) : null;
const complete = [...got.values()].filter((g) => g.count === M - 1).length;
console.log(JSON.stringify({
  inFrames: aus.length, generatedReceived: nOut, generatedExpected: expected, completePairs: complete,
  badFrames: bad,
  latencyMs_lastGeneratedFrameOfPair: { p50: pc(0.5), p95: pc(0.95), max: lat.length ? +lat[lat.length - 1].toFixed(1) : null },
  outFile: OUT,
}, null, 1));
const ok = nOut === expected && bad === 0;
console.log(ok ? 'PROTOCOL TEST PASSED' : 'PROTOCOL TEST: counts or framing differ from expected');
process.exit(ok ? 0 : 2);
