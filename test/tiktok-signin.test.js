'use strict';
// 2.0.8: the recorder's signed-in lookups (the host's TikTok sign-in lives in a browser session the app only asks
// "is there a sign-in cookie?" about; the lookups go through that session's fetch).
const test = require('node:test');
const assert = require('node:assert/strict');
const { TikTokSignIn, USER_AGENT, LOGIN_URL, SESSION_COOKIES, SIGNIN_HOSTS } = require('../src/core/tiktok-signin');

const COOKIE = 'sessionid=SECRET-COOKIE-VALUE';
function fake(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const a = answers.find((x) => url.includes(x.match));
    if (!a) return new Response('', { status: 404 });
    if (a.throw) throw a.throw;
    return new Response(a.body, { status: a.status || 200 });
  };
  return { fetch, calls };
}

test('the three lookups use TikTok\'s own paths and params, a desktop Chrome User-Agent and the session\'s cookies', async () => {
  const f = fake([
    { match: '/webcast/room/info/', body: JSON.stringify({ status_code: 0, data: { status: 2, stream_url: { flv_pull_url: { HD1: 'https://pull.example/a.flv' } } } }) },
    { match: '/api-live/user/room/', body: JSON.stringify({ statusCode: 0, data: { user: { roomId: '7', status: 2 }, liveRoom: { status: 2 } } }) },
    { match: '/@host1/live', body: `<html><script id="SIGI_STATE" type="application/json">${JSON.stringify({ LiveRoom: { liveRoomUserInfo: { user: { roomId: '7', status: 2 }, liveRoom: { status: 2 } } } })}</script></html>` },
  ]);
  const logs = [];
  const s = new TikTokSignIn({ fetch: f.fetch, hasSession: async () => true, log: (l, m) => logs.push(m) });
  assert.equal(await s.signedIn(), true);
  const room = await s.roomInfo('7698965875919031070');
  assert.equal(room.status_code, 0);
  const api = await s.apiLive('host1');
  assert.equal(api.data.user.roomId, '7');
  const page = await s.livePage('host1');
  assert.equal(page.user.roomId, '7');
  const [r, a, p] = f.calls.map((c) => new URL(c.url));
  assert.equal(r.host, 'webcast.tiktok.com'); assert.equal(r.pathname, '/webcast/room/info/'); assert.equal(r.searchParams.get('room_id'), '7698965875919031070'); assert.equal(r.searchParams.get('aid'), '1988');
  assert.equal(a.host, 'www.tiktok.com'); assert.equal(a.pathname, '/api-live/user/room/'); assert.equal(a.searchParams.get('uniqueId'), 'host1'); assert.equal(a.searchParams.get('sourceType'), '54');
  assert.equal(p.host, 'www.tiktok.com'); assert.equal(p.pathname, '/@host1/live');
  for (const c of f.calls) {
    assert.equal(c.init.credentials, 'include', 'the session\'s cookies go along');
    assert.equal(c.init.headers['User-Agent'], USER_AGENT);
    assert.match(c.init.headers['User-Agent'], /Chrome\/\d+/);
    assert.doesNotMatch(c.init.headers['User-Agent'], /Electron/);
    assert.equal(c.init.headers.Cookie, undefined, 'no cookie header is built by hand: the session carries them');
  }
  assert.doesNotMatch(logs.join('\n'), /SECRET/);
});

test('refusals and TikTok\'s own codes: an HTTP status becomes a got-style error; 4003110 comes back as data; the bot check is "waf"', async () => {
  const f = fake([
    { match: 'room_id=7698965875919031070', body: JSON.stringify({ status_code: 4003110, data: { prompts: '' } }) },
    { match: 'room_id=7698965875919031071', body: 'nope', status: 403 },
    { match: '/api-live/user/room/', body: '<html><body>Please wait... <p class="_wafchallengeid"></p></body></html>' },
    { match: '/@host1/live', body: '<html><body>Please wait... <p class="_wafchallengeid"></p></body></html>' },
  ]);
  const s = new TikTokSignIn({ fetch: f.fetch, hasSession: async () => true });
  assert.equal((await s.roomInfo('7698965875919031070')).status_code, 4003110, 'TikTok\'s code is data for the verdict, not an exception');
  await assert.rejects(() => s.roomInfo('7698965875919031071'), (e) => e.response && e.response.statusCode === 403 && e.code === 'ERR_NON_2XX_3XX_RESPONSE');
  await assert.rejects(() => s.apiLive('host1'), (e) => e.code === 'waf');
  await assert.rejects(() => s.livePage('host1'), (e) => e.code === 'waf');
  await assert.rejects(() => s.roomInfo('not a room'), /no room id/);
  await assert.rejects(() => s.apiLive('bad handle!'), /no username/);
});

test('a hung request times out (so the recorder\'s loop goes on); not signed in = never asked', async () => {
  const s = new TikTokSignIn({ fetch: (_u, init) => new Promise((_r, j) => init.signal.addEventListener('abort', () => j(Object.assign(new Error('aborted'), { name: 'AbortError' })))), hasSession: async () => true, timeoutMs: 30 });
  await assert.rejects(() => s.roomInfo('7698965875919031070'), (e) => e.code === 'ETIMEDOUT' && /Timeout/.test(e.message));
  const off = new TikTokSignIn({ fetch: async () => { throw new Error('must not be called'); }, hasSession: async () => false });
  assert.equal(await off.signedIn(), false);
  const none = new TikTokSignIn({});
  assert.equal(await none.signedIn(), false, 'no session fetch at all (headless) = not signed in');
});

test('constants the main process relies on', () => {
  assert.equal(LOGIN_URL, 'https://www.tiktok.com/login');
  assert.ok(SESSION_COOKIES.includes('sessionid') && SESSION_COOKIES.includes('sid_tt'));
  assert.ok(SIGNIN_HOSTS.test('www.tiktok.com') && SIGNIN_HOSTS.test('sso.tiktok.com') && SIGNIN_HOSTS.test('lf16-tiktok-web.ttwstatic.com'));
  assert.ok(!SIGNIN_HOSTS.test('evil.example') && !SIGNIN_HOSTS.test('tiktok.com.evil.example'));
  assert.ok(!COOKIE.includes('tt-target-idc'));   // (the value above is only a stand-in for the log check)
});
