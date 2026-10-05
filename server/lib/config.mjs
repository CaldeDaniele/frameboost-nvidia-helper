import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sea from 'node:sea';

// Packed as a single executable (Node SEA) the project folder is the folder of the .exe; from source it is the repo root.
export const ROOT = sea.isSea() ? path.dirname(process.execPath) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_FILE = path.join(ROOT, 'config.json');
export const VERSION = '0.1.0';

// No look-alike characters (0/O, 1/I): the token is typed or pasted by a person.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newToken() {
  const bytes = crypto.randomBytes(16);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `FB-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

/** Load config.json (created on first run, with a fresh pairing token). Environment variables override. */
export function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* first run */ }
  let dirty = false;
  if (!cfg.token) { cfg.token = newToken(); dirty = true; }
  if (!cfg.port) { cfg.port = 8765; dirty = true; }
  if (dirty) fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  return {
    port: Number(process.env.FB_HELPER_PORT) || cfg.port,
    token: cfg.token,
    sdkRoot: process.env.VFX_SDK_ROOT || cfg.sdkRoot || path.join(ROOT, 'sdk', 'core', 'VideoFX'),
    ffmpeg: process.env.FFMPEG || cfg.ffmpeg || 'ffmpeg',
    vfgpipe: process.env.VFGPIPE || cfg.vfgpipe || path.join(ROOT, 'bin', 'vfgpipe.exe'),
    // Origins allowed besides chrome-extension://* (the status page, tests).
    extraOrigins: cfg.extraOrigins || [],
    maxSessions: cfg.maxSessions || 2,
    encoder: process.env.FB_ENCODER || cfg.encoder || 'x264',   // 'x264' (default) | 'nvenc'
  };
}
