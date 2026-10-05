// Files embedded in the single executable (Node SEA assets); from source they are read from the repo.
import fs from 'node:fs';
import path from 'node:path';
import sea from 'node:sea';
import { IS_SEA, ROOT } from './config.mjs';

const DEV_PATHS = {
  'vfgpipe.exe': ['bin', 'vfgpipe.exe'],
  'ui.html': ['server', 'setup', 'ui.html'],
  'LICENSE': ['LICENSE'],
  'THIRD_PARTY_NOTICES.md': ['THIRD_PARTY_NOTICES.md'],
};

export function getAsset(name) {
  if (IS_SEA) return Buffer.from(sea.getRawAsset(name));
  const rel = DEV_PATHS[name];
  if (!rel) throw new Error(`unknown asset ${name}`);
  return fs.readFileSync(path.join(ROOT, ...rel));
}
