// Manual mode (`--serve`, or `node server/live.mjs`): fixed port, long-lived pairing token, status page.
import { loadConfig, VERSION } from './lib/config.mjs';
import { checkEnvironment } from './lib/health.mjs';
import { createLiveServer } from './lib/wsserver.mjs';

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);

export async function runServe() {
  const cfg = loadConfig({ ensureToken: true });
  const env = await checkEnvironment(cfg);
  const srv = createLiveServer({
    cfg, env, token: cfg.token, statusPage: true, log,
    // Browsers always send Origin: the extension's relay/popup pages carry chrome-extension://<id>.
    originAllowed: (origin) => origin.startsWith('chrome-extension://') || cfg.extraOrigins.includes(origin),
  });
  const port = await srv.listen(cfg.port);
  log(`FrameBoost NVIDIA helper v${VERSION} on http://127.0.0.1:${port}`);
  if (env.problems.length) {
    log('NOT READY:');
    env.problems.forEach((p) => log(' -', p));
  } else {
    log(`ready: ${env.gpu} (driver ${env.driver}), Maxine VFX SDK ${env.sdk}`);
  }
  log(`pairing token: ${cfg.token}   (also shown on the status page)`);
}

// Run directly from source: `node server/live.mjs`
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('server/live.mjs')) {
  runServe().catch((e) => { console.error('FATAL:', e && e.stack || e); process.exitCode = 1; });
}
