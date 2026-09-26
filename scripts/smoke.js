'use strict';
// End-to-end smoke test of the REAL Electron app against the local mock site, with no window shown:
// starts the mock, launches Electron hidden with a throwaway profile, pairs, then checks the app reached
// "ready" and asked the site for its config. Usage: npm run smoke
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createMock } = require('../test/mock-server');

(async () => {
  // verified:false keeps the app from contacting TikTok at all (this PC's free sign-server quota is shared
  // with the T.O.S show program); pairing, token encryption, config and the tray still get exercised.
  const mock = createMock({ autoApprove: true, tiktokUsername: 'smoke_test', verified: false, enabled: true });
  const port = await mock.listen(0);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-smoke-'));
  const electron = require('electron');            // path to the binary when required from Node
  const child = spawn(electron, ['.', '--hidden', `--user-data-dir=${profile}`], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, LIVE_LINK_API: `http://127.0.0.1:${port}/functions/v1/`, LIVE_LINK_SMOKE: 'TEST2345' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('exit', r));
  await mock.close();
  const calls = mock.state.calls.map((c) => c.path);
  const ok = calls.includes('live-link-pair') && calls.includes('live-link-config') && /SMOKE phase=ready/.test(out);
  console.log(out.split('\n').filter((l) => /SMOKE|ERROR|phase|uncaught/i.test(l)).join('\n'));
  console.log('site calls:', calls.join(', '));
  console.log(ok ? 'SMOKE PASS' : `SMOKE FAIL (exit ${code})`);
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})();
