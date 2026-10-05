import { spawn } from 'node:child_process';

const q = (s) => `"${s}"`;

// H.264 Annex-B access units start with an Access Unit Delimiter NAL (00 00 00 01 09): NVENC writes them with -aud 1.
function isAud(buf, i) {
  return buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1 && (buf[i + 4] & 0x1f) === 9;
}
// A picture is complete only when it contains a coded slice (NAL type 1 or 5).
function hasSlice(buf) {
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      const nal = buf[i + (buf[i + 2] === 1 ? 3 : 4)] & 0x1f;
      if (nal === 1 || nal === 5) return true;
    }
  }
  return false;
}

/**
 * One live frame-generation pipeline:
 *   H.264 in -> ffmpeg (decode, 1 thread) -> vfgpipe (Maxine VFG) -> ffmpeg (NVENC) -> H.264 out
 * The three stages are joined by native cmd.exe pipes. Output access units are split on AUD NALs and handed to
 * onAu(au, n) in order (n = 0-based index of the generated frame).
 */
export class Chain {
  constructor({ width, height, fps, multiplier, mode }, cfg, log = () => {}) {
    this.o = { width, height, fps, multiplier, mode };
    this.cfg = cfg;
    this.log = log;
    this.onAu = () => {};
    this.onExit = () => {};
    this.child = null;
    this.ready = false;
    this.exited = false;
    this.inAus = 0;
    this.outAus = 0;
    this.errors = [];
    this.tail = [];
    this.pending = Buffer.alloc(0);
    this.flushTimer = null;
    this.splitAnomalies = 0;
  }

  commandLine() {
    const { width: W, height: H, fps, multiplier: M, mode } = this.o;
    const { ffmpeg, vfgpipe, sdkRoot } = this.cfg;
    // BT.709 both ways: the browser's decoder reads untagged HD H.264 as 709, so the YUV <-> RGB round trip stays neutral.
    const dec = [
      q(ffmpeg), '-hide_banner -loglevel error -threads 1 -flags low_delay',   // 1 thread: frame threading adds N frames of delay
      // Short probing: the default analysis buffers ~1 s of frames before the first output. (-fflags nobuffer makes it worse.)
      `-probesize 32768 -analyzeduration 1 -fpsprobesize 0 -f h264 -framerate ${fps} -i pipe:0`,
      '-vf "scale=in_color_matrix=bt709:in_range=tv:flags=bilinear,format=bgr24"',
      '-f rawvideo -',
    ].join(' ');
    const vfg = [
      q(vfgpipe), `--sdk=${q(sdkRoot)}`,
      `--width=${W} --height=${H} --multiplier=${M} --mode=${mode} --only-generated`,
    ].join(' ');
    // Encoder for the generated frames. x264 zerolatency declares max_num_reorder_frames=0 in the SPS, so the browser's
    // hardware H.264 decoder outputs every frame at once. NVENC (via ffmpeg) does not write that VUI field: Chrome then
    // holds back a whole DPB (4-16 frames, 70-270 ms). Use NVENC only if you rewrite the SPS.
    const encVideo = this.cfg.encoder === 'nvenc'
      ? '-c:v h264_nvenc -preset p1 -tune ull -profile:v baseline -bf 0 -g 120 -aud 1 -rc vbr -cq 21 -b:v 20M -maxrate 40M -bufsize 4M -flush_packets 1'
      : '-c:v libx264 -preset ultrafast -tune zerolatency -crf 19 -maxrate 60M -bufsize 8M -g 120 -x264-params aud=1:annexb=1:scenecut=0:repeat-headers=1 -flush_packets 1';
    const enc = [
      q(ffmpeg), '-hide_banner -loglevel error',
      `-f rawvideo -pix_fmt bgr24 -s ${W}x${H} -r ${fps * (M - 1)} -i -`,
      '-vf "scale=out_color_matrix=bt709:out_range=tv:flags=bilinear,format=yuv420p"',
      '-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv',
      encVideo,
      '-f h264 pipe:1',
    ].join(' ');
    return `${dec} | ${vfg} | ${enc}`;
  }

  /** Spawn and wait until the VFG model is loaded. */
  start(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const line = this.commandLine();
      this.log(`chain: ${this.o.width}x${this.o.height} ${this.o.fps}fps x${this.o.multiplier} ${this.o.mode}`);
      this.child = spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        windowsVerbatimArguments: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => { fail(new Error('timeout loading the frame generation model')); }, timeoutMs);
      let settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
      const fail = (e) => { done(reject, e); this.stop(); };

      this.child.stdin.on('error', () => { /* pipeline died: reported through exit */ });
      this.child.stdout.on('data', (chunk) => this.#onStdout(chunk));
      let errBuf = '';
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (d) => {
        errBuf += d;
        const lines = errBuf.split(/\r?\n/);
        errBuf = lines.pop();
        for (const l of lines) {
          if (l === 'VFGREADY') { this.ready = true; done(resolve); }
          else if (l.startsWith('VFGPROGRESS') || l.startsWith('VFGDONE')) continue;
          else if (l.startsWith('VFGERROR ')) { this.errors.push(l.slice(9)); this.log(l); }
          else if (l.trim()) { this.tail.push(l.trim()); if (this.tail.length > 20) this.tail.shift(); this.log(l); }
        }
      });
      this.child.on('error', (e) => fail(e));
      this.child.on('close', (code) => {
        this.exited = true;
        clearTimeout(this.flushTimer);
        const why = this.#why(code);
        if (!settled) done(reject, new Error(why));
        this.onExit(why);
      });
    });
  }

  #why(code) {
    const noise = /Broken pipe|Error muxing|Error submitting|Error writing trailer|Error closing file|Conversion failed/;
    const causes = this.tail.filter((l) => !noise.test(l)).slice(0, 2);
    const own = this.errors.filter((e) => e !== 'stdout closed');
    return [...own, ...causes].join(' | ') || `pipeline exited (code ${code})`;
  }

  /** Feed one H.264 access unit from the browser. */
  write(au) {
    if (this.exited || !this.child) return false;
    this.inAus++;
    return this.child.stdin.write(au);
  }

  get pendingBytes() { return this.child ? this.child.stdin.writableLength : 0; }

  #onStdout(chunk) {
    // Append, then cut at every AUD that is not at offset 0: each cut completes the previous access unit.
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let start = 0;
    for (let i = this.pending.length === 0 ? 1 : Math.max(1, this.pending.length - 4); i + 4 < buf.length; i++) {
      if (buf[i] === 0 && isAud(buf, i)) {
        if (i > start) this.#emit(buf.subarray(start, i));
        start = i;
      }
    }
    this.pending = Buffer.from(buf.subarray(start));   // copy: do not pin the large read buffer
    clearTimeout(this.flushTimer);
    // NVENC writes a whole frame in one burst. If nothing follows within a moment the picture is complete; waiting
    // for the next AUD would cost a full frame interval of latency.
    if (this.pending.length) this.flushTimer = setTimeout(() => this.#flushPending(), 2);
  }

  #flushPending() {
    if (!this.pending.length) return;
    if (!hasSlice(this.pending)) return;     // only AUD/SPS/PPS so far: the slice is still on its way
    const au = this.pending;
    this.pending = Buffer.alloc(0);
    this.#emit(au);
  }

  #emit(au) {
    if (!isAud(au, 0)) this.splitAnomalies++;   // a frame was cut mid-way (should not happen)
    this.onAu(au, this.outAus++);
  }

  stop() {
    clearTimeout(this.flushTimer);
    if (this.child && !this.exited) {
      try { this.child.stdin.destroy(); } catch { /* already closed */ }
      spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    }
  }
}
