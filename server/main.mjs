#!/usr/bin/env node
// Entry point of frameboost-helper.exe (and `node server/main.mjs`). The mode follows from how we were started:
//   chrome-extension://<id>/   → native messaging host (the browser started us)
//   --serve                    → manual server: fixed port + pairing token + status page
//   --register [--allow <id>…] / --unregister / --uninstall / --check / --version / --help
//   (nothing)                  → installer wizard (double click)
import path from 'node:path';
import { IS_SEA, INSTALL_DIR, VERSION, loadConfig } from './lib/config.mjs';

const args = process.argv.slice(2);
const first = args[0] || '';
const has = (f) => args.includes(f);
const values = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));

async function main() {
  if (first.startsWith('chrome-extension://') || first.startsWith('moz-extension://')) {
    const { runNativeHost } = await import('./native.mjs');
    return runNativeHost(first);
  }
  if (has('--version')) { console.log(`frameboost-helper ${VERSION}`); return; }
  if (has('--help') || has('-h')) {
    console.log(`FrameBoost NVIDIA helper ${VERSION}

  (no arguments)     installer wizard
  --serve            manual server (fixed port, pairing token, status page)
  --register         register the native messaging host for this exe [--allow <extension-id> ...]
  --unregister       remove the registration
  --uninstall        unregister and delete ${INSTALL_DIR}
  --check            print a JSON report about this PC
  --version`);
    return;
  }
  if (has('--check')) {
    const { checkEnvironment } = await import('./lib/health.mjs');
    console.log(JSON.stringify(await checkEnvironment(loadConfig())));
    return;
  }
  if (has('--serve')) {
    const { runServe } = await import('./live.mjs');
    return runServe();
  }
  if (has('--register')) {
    const { registerNativeHost } = await import('./lib/registry.mjs');
    const { DEFAULT_EXTENSION_IDS } = await import('./lib/config.mjs');
    const exe = IS_SEA ? process.execPath : path.resolve(process.argv[1]);
    const r = registerNativeHost({ exePath: exe, allowedIds: [...DEFAULT_EXTENSION_IDS, ...values('--allow')] });
    console.log(`registered for: ${r.registered.join(', ') || '(none)'}${r.failed.length ? `; failed: ${r.failed.join(', ')}` : ''}\nmanifest: ${r.manifest}`);
    return;
  }
  if (has('--unregister')) {
    const { unregisterNativeHost } = await import('./lib/registry.mjs');
    console.log(`removed from: ${unregisterNativeHost().join(', ') || '(nothing was registered)'}`);
    return;
  }
  if (has('--uninstall')) {
    const { uninstallHelper } = await import('./lib/install.mjs');
    console.log(JSON.stringify(uninstallHelper()));
    return;
  }
  const { runWizard } = await import('./setup/wizard.mjs');
  await runWizard({ open: !has('--no-open') });
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack || e);
  process.exitCode = 1;
});
