import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sea from 'node:sea';

// Packed as a single executable (Node SEA) the project folder is the folder of the .exe; from source it is the repo root.
export const IS_SEA = sea.isSea();
export const ROOT = IS_SEA ? path.dirname(process.execPath) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_FILE = path.join(ROOT, 'config.json');
export const VERSION = '0.2.0';

/** Where the installer puts everything (per user, no admin). */
export const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'), 'FrameBoostNvidia');
/** The Web Store extension; developer builds are added with --allow <id> / the wizard's advanced field. */
export const STORE_EXTENSION_ID = 'cklkjjeejomlkelkjmgdpahgpcjigahb';

// No look-alike characters (0/O, 1/I): the token is typed or pasted by a person.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newToken() {
  const bytes = crypto.randomBytes(16);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `FB-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

/**
 * Load config.json next to the exe (or the repo root). `ensureToken` creates the file with a fresh pairing token on first
 * run (manual `--serve` mode only: the native host uses a token per start and never stores one).
 * Environment variables override file values.
 */
export function loadConfig({ ensureToken = false } = {}) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* none yet */ }
  if (ensureToken) {
    let dirty = false;
    if (!cfg.token) { cfg.token = newToken(); dirty = true; }
    if (!cfg.port) { cfg.port = 8765; dirty = true; }
    if (dirty) fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  }
  const localFfmpeg = path.join(ROOT, 'ffmpeg', 'ffmpeg.exe');
  return {
    port: Number(process.env.FB_HELPER_PORT) || cfg.port || 8765,
    token: cfg.token,
    sdkRoot: process.env.VFX_SDK_ROOT || cfg.sdkRoot || path.join(ROOT, 'sdk', 'core', 'VideoFX'),
    ffmpeg: process.env.FFMPEG || cfg.ffmpeg || (fs.existsSync(localFfmpeg) ? localFfmpeg : 'ffmpeg'),
    vfgpipe: process.env.VFGPIPE || cfg.vfgpipe || path.join(ROOT, 'bin', 'vfgpipe.exe'),
    // Origins allowed besides chrome-extension://* in manual mode (the status page, tests).
    extraOrigins: cfg.extraOrigins || [],
    maxSessions: cfg.maxSessions || 2,
    encoder: process.env.FB_ENCODER || cfg.encoder || 'x264',   // 'x264' (default) | 'nvenc'
    // Extension IDs the native host manifest allows (the installer writes them, see registry.mjs).
    allowedExtensionIds: cfg.allowedExtensionIds || [STORE_EXTENSION_ID],
  };
}
