'use strict';
// V8 (the puppet show), contract C3: the show state for the Mask (the song on air, its cover, the hype rank, the host's
// grade). Every read goes to test/mock-server.js on a random free port (its /rest/v1/ stand-in for the site's public
// tables); nothing here talks to the real site. Songs, hosts and grades are made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMock } = require('./mock-server');
const F = require('../src/core/show-feed');
const { ShowFeed, hypeOf, climb, rankPosition, tapsAtRankPosition, gradeToScore, coverOf } = F;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(5); } return false; }

const SITE = 'site-storage.example';
const COVER = `https://${SITE}/storage/v1/object/public/submission-attachments/u1/cover.png`;
const SONG = { submission_id: 'sub-1', title: 'Test Song' };
const iso = (t) => new Date(t).toISOString();

// A feed against the stand-in site. speed: the feed's clocks run this many times faster than the real ones, so
// "15 seconds a rank" can be watched in a fraction of a second.
async function setup(t, { speed = 1, wanted = () => true, take = () => true, opts = {} } = {}) {
  const mock = createMock();
  const port = await mock.listen(0);
  const t0 = Date.now(), base = 1_800_000_000_000;
  const now = () => base + (Date.now() - t0) * speed;
  const sent = [];
  const logs = [];
  const feed = new ShowFeed({ restBase: `http://127.0.0.1:${port}/rest/v1/`, apiKey: 'test-publishable-key', coverHosts: [SITE],
    send: (m) => { if (take(m) === false) return false; sent.push(m); return true; }, wanted, log: (l, m) => logs.push(`${l} ${m}`),
    now, mono: () => (Date.now() - t0) * speed, pollMs: 40, pollMaxMs: 320, tickMs: 15, keepMs: 5000, lateGradeMs: [60, 160], lateScoreShowMs: 400 * speed,
    finishTryMs: [0, 30, 80], finishGradeMs: [260, 360], finishShowMs: 400 * speed, ...opts });
  t.after(async () => { feed.stop(); await mock.close(); });
  const rest = mock.state.rest;
  const reads = (table) => mock.state.restCalls.filter((c) => !table || c.table === table);
  return { mock, feed, sent, logs, rest, reads, now, last: () => sent[sent.length - 1] };
}
const onAir = (target = SONG) => ({ connected: true, target, hold: null });

// ---------------------------------------------------------------- the hype math (the site's numbers)

test('hype ranks: the site\'s thresholds (1, 300, 900, 1800, 3600, 8000, +1 MYTHIC per further 8000)', () => {
  assert.deepEqual(F.HYPE_TIERS.map((x) => x.min), [0, 1, 300, 900, 1800, 3600, 8000]);
  assert.deepEqual([F.MYTHIC_MIN, F.MYTHIC_STEP, F.RANKS_PER_SECOND], [8000, 8000, 1 / 15]);
  const at = (n) => { const h = hypeOf(n); return [h.rank, h.label, h.mythic]; };
  assert.deepEqual(at(0), [0, 'Tap to hype it up', 0]);
  assert.deepEqual(at(1), [1, 'Warming Up', 0]);
  assert.deepEqual(at(299), [1, 'Warming Up', 0]);
  assert.deepEqual(at(300), [2, 'Heating Up', 0]);
  assert.deepEqual(at(899), [2, 'Heating Up', 0]);
  assert.deepEqual(at(900), [3, 'ON FIRE', 0]);
  assert.deepEqual(at(1800), [4, 'WILDFIRE', 0]);
  assert.deepEqual(at(3600), [5, 'LEGENDARY', 0]);
  assert.deepEqual(at(7999), [5, 'LEGENDARY', 0]);
  assert.deepEqual(at(8000), [6, 'MYTHIC', 0]);
  assert.deepEqual(at(15999), [6, 'MYTHIC', 0]);
  assert.deepEqual(at(16000), [6, 'MYTHIC x2', 1], 'the first "+1 MYTHIC"');
  assert.deepEqual(at(24000), [6, 'MYTHIC x3', 2]);
  assert.deepEqual(at(800000), [6, 'MYTHIC x100', 99]);
  for (const bad of [-5, NaN, undefined, null, 'x']) assert.deepEqual(hypeOf(bad), { taps: 0, rank: 0, label: 'Tap to hype it up', mythic: 0 });
  assert.equal(hypeOf(1234.9).taps, 1234, 'whole taps');
});

test('rank position and its inverse are the site\'s (0 at 0 taps, 1 at 300, 2 at 900, 3 at 1800, 4 at 3600, 5 at 8000, +1 per 8000)', () => {
  assert.deepEqual([0, 300, 900, 1800, 3600, 8000, 16000, 24000].map(rankPosition), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(rankPosition(150), 0.5);
  assert.equal(rankPosition(600), 1.5);
  assert.equal(rankPosition(12000), 5.5);
  for (const n of [0, 1, 150, 299, 300, 777, 900, 2500, 3600, 5000, 8000, 9000, 20000]) assert.ok(Math.abs(tapsAtRankPosition(rankPosition(n)) - n) < 1e-6, `round trip ${n}`);
  assert.equal(rankPosition(-3), 0);
  assert.equal(tapsAtRankPosition(-1), 0);
});

test('the climb: at most one rank per 15 s, whole taps, never above the real taps, a lower real value at once (as the overlay does)', () => {
  // a sudden 8,000 taps, in the feed's half-second ticks: never ahead of the 15-s-a-rank line, whole taps, every rank on
  // the way, and at MYTHIC after 75 s or a little later (the site rounds each 100 ms step down; so does this)
  let s = 0, reached = null; const ranks = [0];
  for (let i = 1; i <= 240 && reached === null; i++) {
    s = climb(s, 8000, 0.5);
    assert.ok(s <= tapsAtRankPosition((i * 0.5) / 15) + 1e-6, `at ${i * 0.5} s: ${s}`);
    assert.ok(Number.isInteger(s));
    const r = hypeOf(s).rank; if (ranks[ranks.length - 1] !== r) ranks.push(r);
    if (s === 8000) reached = i * 0.5;
  }
  assert.deepEqual(ranks, [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(reached >= 75 && reached <= 110, `MYTHIC after ${reached} s`);
  // one long step is the same walk as many short ones (a tick that came late loses nothing and gains nothing)
  let a = 0, b = 0;
  for (let i = 0; i < 40; i++) a = climb(a, 5000, 0.5);
  b = climb(b, 5000, 20);
  assert.ok(Math.abs(a - b) <= 2, `${a} and ${b}`);
  const g = climb(100, 120, 0.5);
  assert.ok(g >= 105 && g <= 110, `a small gap closes at the same pace (about 10 taps per half second in the first rank): ${g}`);
  assert.equal(climb(100, 104, 0.5), 104, 'reached: exactly the real value');
  assert.equal(climb(500, 200, 0.5), 200, 'a lower real value is taken at once');
  assert.equal(climb(500, 500, 10), 500);
  assert.equal(climb(0, 0, 10), 0);
  assert.equal(climb(0, 5000, 0), 0, 'no time passed: no climb');
  // past MYTHIC: one "+1 MYTHIC" (8,000 taps) per 15 s, or a little under
  const m = climb(8000, 40000, 15);
  assert.ok(m > 15000 && m <= 16000, `past MYTHIC: ${m}`);
});

test('the host\'s grade as 0-100 for the Mask: Fire 95, Hidden Gem 82 (fire), Solid 60 (a puff), Promising 38 (goo); letters map too; anything else is no score', () => {
  assert.deepEqual(F.GRADE_SCORE, { fire: 95, gem: 82, solid: 60, promising: 38 });
  assert.deepEqual(['fire', 'gem', 'solid', 'promising', 'FIRE', ' Gem '].map(gradeToScore), [95, 82, 60, 38, 95, 82]);
  assert.deepEqual(['S', 'A', 'B', 'C', 'D', 'F', 'a'].map(gradeToScore), [98, 88, 72, 55, 40, 20, 88]);
  for (const g of [null, undefined, '', 'great', 7, {}, 'constructor', '__proto__']) assert.equal(gradeToScore(g), null, String(g));
  // the Mask's own lines (mask-v8.js): fire at 70 and above, goo at 40 and below
  assert.ok(gradeToScore('fire') >= 70 && gradeToScore('gem') >= 70);
  assert.ok(gradeToScore('solid') > 40 && gradeToScore('solid') < 70);
  assert.ok(gradeToScore('promising') <= 40);
});

test('the cover: the overlay\'s rule (album art, else the first picture attached), only from the site\'s storage; anything else is no cover', () => {
  assert.equal(coverOf({ album_artwork_url: COVER, attachment_urls: [`https://${SITE}/other.png`] }, [SITE]), COVER);
  assert.equal(coverOf({ album_artwork_url: null, attachment_urls: [`https://${SITE}/song.mp3`, `https://${SITE}/art.JPG`, `https://${SITE}/later.png`] }, [SITE]), `https://${SITE}/art.JPG`);
  assert.equal(coverOf({ album_artwork_url: 'https://img.youtube.com/vi/abcdefghijk/mqdefault.jpg', attachment_urls: null }, [SITE]), null, 'a YouTube thumbnail is not passed on');
  assert.equal(coverOf({ album_artwork_url: `http://${SITE}/a.png` }, [SITE]), null, 'not https');
  assert.equal(coverOf({ album_artwork_url: `https://${SITE}.evil.example/a.png` }, [SITE]), null);
  assert.equal(coverOf({ album_artwork_url: 'https://evil.example/a.png', attachment_urls: [COVER] }, [SITE]), COVER, 'bad album art: the attached picture');
  for (const s of [null, undefined, {}, { album_artwork_url: 5, attachment_urls: 'x' }]) assert.equal(coverOf(s, [SITE]), null);
  assert.equal(coverOf({ album_artwork_url: COVER }, []), null, 'no cover host known: no cover');
});

// ---------------------------------------------------------------- the feed

test('before the controller has said anything: nothing is read and nothing is sent. No song: "off air" right away and at least every 5 s, still nothing read; 2.3.1: a TikTok LIVE that drops does not silence it', async (t) => {
  const x = await setup(t, { speed: 10 });                       // 5 s of the feed's clock = 500 ms
  await wait(120);
  assert.equal(x.sent.length + x.reads().length, 0);
  for (const hold of ['song', 'show']) x.feed.update({ connected: true, target: hold === 'show' ? SONG : null, hold });
  assert.ok(await until(() => x.sent.length >= 3, 6000));   // (the slack below is for a busy computer's late timers)
  for (const m of x.sent) assert.deepEqual({ ...m, at: 0 }, { v: 2, type: 'show', onAir: false, song: null, hype: { taps: 0, rank: 0, label: 'Tap to hype it up', mythic: 0 }, score: null, grade: null, finish: null, at: 0 });
  for (let i = 1; i < x.sent.length; i++) assert.ok(x.sent[i].at - x.sent[i - 1].at <= 5000 + 3000, `gap ${x.sent[i].at - x.sent[i - 1].at} ms of the feed's clock`);
  assert.ok(x.sent[1].at - x.sent[0].at >= 4000, 'unchanged: not more often than the 5 s beat');
  assert.equal(x.reads().length, 0, 'no song on air: the site is not asked anything');
  // 2.3.1: the TikTok LIVE drops (or was never connected): the state still goes out, still nothing is read
  x.feed.update({ connected: false, target: null, hold: null });
  const n = x.sent.length;
  assert.ok(await until(() => x.sent.length >= n + 2, 6000), 'still said at least every 5 s');
  assert.ok(x.sent.slice(n).every((m) => m.onAir === false && m.song === null));
  assert.equal(x.reads().length, 0);
  // stopped (LIVE Link quits): silence
  x.feed.stop();
  const k = x.sent.length;
  await wait(200);
  assert.equal(x.sent.length, k);
});

test('a song on air: read with the publishable key (GET only), its cover and title sent, the hype climbs one rank per 15 s and never ahead of that', async (t) => {
  const x = await setup(t, { speed: 100 });                       // 15 s = 150 ms
  const started = x.now();
  x.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 6000 }, { submission_id: 'other', hype_bar: 99999 });
  x.rest.hype_plays.push({ id: 'p0', submission_id: 'sub-1', host_id: 'host-1', start_bar: 0, end_bar: 1000, started_at: iso(started - 3600000), ended_at: iso(started - 3500000) },
    { id: 'p1', submission_id: 'sub-1', host_id: 'host-1', start_bar: 1000, end_bar: null, started_at: iso(started), ended_at: null });
  x.rest.submissions_public.push({ id: 'sub-1', title: 'Test Song', album_artwork_url: COVER, attachment_urls: [] });
  x.feed.update(onAir());
  assert.equal(x.sent[0].onAir, true, 'on air is said at once, before any read');
  assert.deepEqual(x.sent[0].song, { id: 'sub-1', title: 'Test Song', cover: null });
  assert.ok(await until(() => x.last().song.cover === COVER), 'the cover arrives with the first read');
  assert.ok(await until(() => x.last().hype.rank === 5 && x.last().hype.taps === 5000, 4000), `ended at ${JSON.stringify(x.last().hype)}`);
  // this play's taps = bar - start_bar = 5,000 = LEGENDARY; reached rank by rank, never ahead of 15 s a rank
  const ranks = [];
  for (const m of x.sent) {
    assert.equal(m.onAir, true);
    const allowed = tapsAtRankPosition(Math.max(0, m.at - started) / 1000 / 15);
    assert.ok(m.hype.taps <= allowed + 1, `at ${(m.at - started) / 1000} s: ${m.hype.taps} taps shown, ${Math.floor(allowed)} allowed`);
    assert.ok(m.hype.taps <= 5000);
    if (ranks[ranks.length - 1] !== m.hype.rank) ranks.push(m.hype.rank);
  }
  // (that every rank is passed through is the climb's own test above; here a late timer may fold two into one tick)
  assert.deepEqual([ranks[0], ranks[ranks.length - 1]], [0, 5]);
  assert.ok(ranks.length >= 4 && ranks.every((r, i) => i === 0 || r > ranks[i - 1]), `ranks only go up, step by step: ${ranks}`);
  assert.ok(x.last().at - started >= 60000, 'LEGENDARY (4.3 ranks up) took over a minute of the feed\'s clock');
  // the reads: GET only, with the key, only this song, only the public tables (2.3.1: + radio_tracks, for ADD TO AI RADIO)
  for (const c of x.reads()) { assert.equal(c.method, 'GET'); assert.equal(c.apikey, true); assert.match(c.query, /sub-1/); }
  assert.deepEqual([...new Set(x.reads().map((c) => c.table))].sort(), ['hype_plays', 'project_hype', 'radio_tracks', 'ranking_board', 'submissions_public']);
  assert.equal(x.reads('submissions_public').length, 1, 'the cover is asked for once per song');
  assert.ok(x.reads('hype_plays').length < x.reads('project_hype').length, 'an open play is looked at less often than the bar');
  assert.equal(x.mock.state.calls.length, 0, 'no LIVE Link endpoint was called by the feed');
  // more taps: MYTHIC and beyond
  x.rest.project_hype[0].hype_bar = 1000 + 17000;
  assert.ok(await until(() => x.last().hype.mythic === 1, 5000), JSON.stringify(x.last().hype));
  assert.deepEqual([x.last().hype.rank, x.last().hype.label], [6, 'MYTHIC x2']);
});

test('only an OPEN play counts: a song that just went on air does not wear its last play\'s rank; the new play starts at 0 from its own start_bar', async (t) => {
  const x = await setup(t, { speed: 100 });
  const now = x.now();
  x.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 9000 });
  x.rest.hype_plays.push({ id: 'old', submission_id: 'sub-1', host_id: 'host-1', start_bar: 0, end_bar: 9000, started_at: iso(now - 86400000), ended_at: iso(now - 86000000) });
  x.feed.update(onAir());
  assert.ok(await until(() => x.reads('hype_plays').length >= 3));
  assert.ok(x.sent.every((m) => m.hype.taps === 0 && m.hype.rank === 0), 'the old play\'s 9,000 taps (MYTHIC) are not shown');
  assert.equal(x.reads('hype_plays').length, x.reads('project_hype').length, 'no open play yet: looked for on every read');
  // the site opens the new play; 400 taps come in
  x.rest.hype_plays.push({ id: 'new', submission_id: 'sub-1', host_id: 'host-1', start_bar: 9000, end_bar: null, started_at: iso(x.now()), ended_at: null });
  x.rest.project_hype[0].hype_bar = 9400;
  assert.ok(await until(() => x.last().hype.taps === 400, 4000), JSON.stringify(x.last().hype));
  assert.equal(x.last().hype.rank, 2);
  assert.ok(Math.max(...x.sent.map((m) => m.hype.taps)) === 400, 'never more than this play\'s own taps');
});

test('joining a play that began long ago: the shown taps start at the real value (as a freshly opened overlay does), not from zero', async (t) => {
  const x = await setup(t);
  x.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 2500 });
  x.rest.hype_plays.push({ id: 'p1', submission_id: 'sub-1', host_id: 'host-1', start_bar: 500, end_bar: null, started_at: iso(x.now() - 10 * 60000), ended_at: null });
  x.feed.update(onAir());
  assert.ok(await until(() => x.last().hype.taps === 2000, 2000), JSON.stringify(x.last().hype));
  assert.equal(x.last().hype.rank, 4);
});

test('the grade: only the host\'s verdict given DURING this play comes out (an old one, or another host\'s, does not); a new song starts with none', async (t) => {
  const x = await setup(t, { speed: 20 });
  const started = x.now();
  for (const id of ['sub-1', 'sub-2']) {
    x.rest.project_hype.push({ submission_id: id, hype_bar: 10 });
    x.rest.hype_plays.push({ id: 'p-' + id, submission_id: id, host_id: 'host-1', start_bar: 0, end_bar: null, started_at: iso(started), ended_at: null });
  }
  x.rest.ranking_board.push({ submission_id: 'sub-1', host_id: 'host-1', host_grade: 'promising', reviewed_at: iso(started - 7 * 86400000) },   // last week's review
    { submission_id: 'sub-1', host_id: 'host-2', host_grade: 'fire', reviewed_at: iso(started + 1000) },                                       // another host, now
    { submission_id: 'sub-1', host_id: 'host-1', host_grade: null, reviewed_at: iso(started + 1000) },
    { submission_id: 'sub-2', host_id: 'host-1', host_grade: 'solid', reviewed_at: iso(started - 1000) });
  x.feed.update(onAir());
  assert.ok(await until(() => x.reads('ranking_board').length >= 3));
  assert.ok(x.sent.every((m) => m.score === null), 'no verdict in this play yet');
  x.rest.ranking_board.push({ submission_id: 'sub-1', host_id: 'host-1', host_grade: 'gem', reviewed_at: iso(x.now()) });
  assert.ok(await until(() => x.last().score === 82, 3000), `score ${x.last().score}`);
  const asked = x.reads('ranking_board').length;
  await wait(200);
  assert.equal(x.reads('ranking_board').length, asked, 'graded: not asked again for this song');
  assert.equal(x.sent.filter((m, i) => m.score === 82 && (i === 0 || x.sent[i - 1].score !== 82)).length, 1, 'the score appears once and stays');
  // the next song: its verdict is from before its play began
  x.feed.update(onAir({ submission_id: 'sub-2', title: 'Next Song' }));
  assert.deepEqual([x.last().song.id, x.last().song.title, x.last().score, x.last().hype.taps], ['sub-2', 'Next Song', null, 0]);
  assert.ok(await until(() => x.reads('ranking_board').filter((c) => /sub-2/.test(c.query)).length >= 2));
  assert.equal(x.last().score, null);
});

test('a verdict given as the song ends: looked for twice more, then sent with that song (off air) and cleared again', async (t) => {
  const x = await setup(t);
  const started = x.now();
  x.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 10 });
  x.rest.hype_plays.push({ id: 'p1', submission_id: 'sub-1', host_id: 'host-1', start_bar: 0, end_bar: null, started_at: iso(started - 5000), ended_at: null });
  x.rest.submissions_public.push({ id: 'sub-1', title: 'Test Song', album_artwork_url: COVER, attachment_urls: [] });
  x.feed.update(onAir());
  assert.ok(await until(() => x.last().song && x.last().song.cover === COVER && x.reads('ranking_board').length >= 1));
  x.feed.update({ connected: true, target: null, hold: 'song' });                    // the song goes off air, ungraded
  assert.deepEqual([x.last().onAir, x.last().song, x.last().score], [false, null, null]);
  x.rest.ranking_board.push({ submission_id: 'sub-1', host_id: 'host-1', host_grade: 'fire', reviewed_at: iso(x.now()) });
  assert.ok(await until(() => x.last().score === 95, 2000), 'the late verdict is found');
  assert.deepEqual({ ...x.last(), at: 0 }, { v: 2, type: 'show', onAir: false, song: { id: 'sub-1', title: 'Test Song', cover: COVER }, hype: { taps: 0, rank: 0, label: 'Tap to hype it up', mythic: 0 }, score: 95, grade: 'fire', finish: null, at: 0 });
  assert.ok(await until(() => x.last().score === null && x.last().song === null, 2000), 'and it is cleared again');
  const reads = x.reads().length;
  await wait(250);
  assert.equal(x.reads().length, reads, 'off air: no more reads');
  // off air WITH a grade already sent: no late look at all
  x.feed.update(onAir());
  assert.ok(await until(() => x.last().score === 95, 2000));
  const before = x.reads('ranking_board').length;
  x.feed.update({ connected: true, target: null, hold: 'song' });
  await wait(250);
  assert.equal(x.reads('ranking_board').length, before);
});

test('off air in every way the site says it (no target, show not on, nothing on air): no song, an empty bar, no reads; odd song ids are never put in an address', async (t) => {
  const x = await setup(t);
  x.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 500 });
  x.rest.hype_plays.push({ id: 'p1', submission_id: 'sub-1', host_id: 'host-1', start_bar: 0, end_bar: null, started_at: iso(x.now() - 600000), ended_at: null });
  for (const off of [{ target: null, hold: 'song' }, { target: SONG, hold: 'show' }, { target: SONG, hold: 'song' }, { target: null, hold: null }]) {
    x.feed.update(onAir());
    assert.ok(await until(() => x.last().onAir && x.last().hype.taps === 500, 2000));
    x.feed.update({ connected: true, ...off });
    assert.deepEqual([x.last().onAir, x.last().song, x.last().hype.taps, x.last().hype.rank], [false, null, 0, 0], JSON.stringify(off));
    const n = x.reads('project_hype').length;
    await wait(130);
    assert.equal(x.reads('project_hype').length, n, 'no bar reads while off air');
  }
  // test mode (taps are checked, not added) still has a song on air
  x.feed.update({ connected: true, target: SONG, hold: 'test' });
  assert.equal(x.last().onAir, true);
  x.feed.update({ connected: true, target: null, hold: null });
  await wait(200);                                                                  // (2.3.1: the three looks at the song's status are over)
  const n = x.reads().length;
  for (const id of ['../../auth/v1/admin', 'a b', 'x&select=*', '', 5, null, 'a'.repeat(65)]) {
    x.feed.update({ connected: true, target: { submission_id: id, title: 'Odd' }, hold: null });
    assert.equal(x.last().onAir, false, String(id));
  }
  await wait(100);
  assert.equal(x.reads().length, n);
  // a title with control characters and a too-long title are cleaned
  x.feed.update(onAir({ submission_id: 'sub-1', title: 'A\u0000\u202e\n  B ' + 'x'.repeat(200) }));
  assert.equal(x.last().song.title, ('A B ' + 'x'.repeat(200)).slice(0, 80));
});

test('gentle on the site: a failing read doubles the wait (40, 80, 160, 320 ms here; 2.5 s to 30 s for real), a 429 is obeyed, one good read puts it back; said once in the log', async (t) => {
  const x = await setup(t);
  // the waits themselves
  const f = new ShowFeed({ send: () => true });
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map((n) => { f.fails = n; return f.nextWaitMs(); }), [2500, 5000, 10000, 20000, 30000, 30000, 30000]);
  f.fails = 0; f.retryAfterMs = 12000;
  assert.equal(f.nextWaitMs(), 12000, 'never sooner than a 429 asked for');
  f.stop();
  x.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 700 });
  x.rest.hype_plays.push({ id: 'p1', submission_id: 'sub-1', host_id: 'host-1', start_bar: 0, end_bar: null, started_at: iso(x.now() - 600000), ended_at: null });
  x.feed.update(onAir());
  assert.ok(await until(() => x.last().hype.taps === 700, 2000));
  // the site starts failing
  x.mock.state.restFail = () => ({ status: 503 });
  const from = Date.now(), at0 = x.reads('project_hype').length;
  await wait(1000);
  const times = x.reads('project_hype').slice(at0).map((c) => c.at - from);
  assert.ok(times.length >= 3 && times.length <= 7, `${times.length} reads in 1 s of failing (25 at the usual pace): ${times}`);
  const gaps = times.slice(1).map((v, i) => v - times[i]);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] >= gaps[i - 1] * 0.5, `the waits grow: ${gaps}`);
  assert.ok(Math.max(...gaps) <= 320 + 400, `capped: ${gaps}`);
  assert.equal(x.feed.fails >= 3, true);
  assert.equal(x.last().hype.taps, 700, 'the last good bar stays on the Mask while the site is away');
  assert.equal(x.last().onAir, true);
  // a 429 with Retry-After: 1
  x.mock.state.restFail = () => ({ status: 429, retryAfter: 1 });
  assert.ok(await until(() => x.feed.retryAfterMs === 1000, 2000), 'Retry-After was read');
  const n429 = x.reads('project_hype').length;
  await wait(700);
  assert.ok(x.reads('project_hype').length <= n429 + 1, 'waited the second the site asked for');
  // back again
  x.mock.state.restFail = null;
  x.rest.project_hype[0].hype_bar = 950;
  assert.ok(await until(() => x.feed.real === 950 && x.feed.fails === 0, 4000), 'reads again');
  const a = x.reads('project_hype').length;
  await wait(500);
  assert.ok(x.reads('project_hype').length - a >= 3, 'the usual pace is back');
  assert.deepEqual(x.logs, ['warn show feed: the site did not answer a read of the hype bar: trying again more slowly', 'info show feed: the site answers again']);
});

test('no VTuber that wants it: nothing is read from the site at all; when one appears the reads begin; a VTuber that is busy gets the same state offered again', async (t) => {
  let wanted = false, busy = true;
  const x = await setup(t, { wanted: () => wanted, take: () => !busy });
  x.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 42 });
  x.rest.hype_plays.push({ id: 'p1', submission_id: 'sub-1', host_id: 'host-1', start_bar: 0, end_bar: null, started_at: iso(x.now() - 600000), ended_at: null });
  x.feed.update(onAir());
  await wait(200);
  assert.equal(x.reads().length, 0, 'no VTuber: the site is left alone');
  assert.equal(x.sent.length, 0);
  wanted = true;
  assert.ok(await until(() => x.reads('project_hype').length >= 2, 2000), 'a VTuber appeared: reading');
  assert.equal(x.sent.length, 0, 'still busy: nothing taken');
  busy = false;
  assert.ok(await until(() => x.sent.length >= 1 && x.last().hype.taps === 42, 2000), 'the state it missed is offered again');
  wanted = false;
  const n = x.reads().length;
  await wait(200);
  assert.ok(x.reads().length <= n + 1, 'it went away: the reads stop');
});

test('a throwing send, a throwing wanted() and a site that answers nonsense never break the feed', async (t) => {
  let mode = 'throw';
  const x = await setup(t, { take: () => { if (mode === 'throw') throw new Error('boom'); return true; }, wanted: () => { if (mode === 'throw') throw new Error('boom'); return true; } });
  x.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 'not a number' });
  x.rest.hype_plays.push({ id: 'p1', submission_id: 'sub-1', host_id: 'host-1', start_bar: null, end_bar: null, started_at: 'not a date', ended_at: null });
  x.rest.submissions_public.push({ id: 'sub-1', title: 5, album_artwork_url: { a: 1 }, attachment_urls: 'x' });
  x.rest.ranking_board.push({ submission_id: 'sub-1', host_id: 'host-1', host_grade: 'fire', reviewed_at: 'not a date' });
  assert.doesNotThrow(() => x.feed.update(onAir()));
  await wait(150);
  mode = 'ok';
  assert.ok(await until(() => x.reads('ranking_board').length >= 2 && x.sent.length >= 1, 3000));
  assert.deepEqual([x.last().onAir, x.last().song.cover, x.last().hype.taps, x.last().score], [true, null, 0, null], 'nonsense reads as nothing');
  for (const bad of [undefined, null, 5, 'x', { connected: true, target: 'x' }, { connected: true, target: { submission_id: {} } }]) assert.doesNotThrow(() => x.feed.update(bad));
});

/// ---------------------------------------------------------------- 2.3.1: the song on air without TikTok

test('2.3.1 the on-air song comes from active_projects with TikTok disconnected: the hype-target row (else the newest), read for this host only, GET only', async (t) => {
  const x = await setup(t, { opts: { hostId: () => 'host-1' } });
  const now = x.now();
  x.rest.active_projects.push(
    { id: 'a1', submission_id: 'sub-old', activated_at: iso(now - 60000), host_id: 'host-1', is_hype_target: false },
    { id: 'a2', submission_id: 'sub-9', activated_at: iso(now - 30000), host_id: 'host-1', is_hype_target: true },
    { id: 'a3', submission_id: 'sub-new', activated_at: iso(now - 1000), host_id: 'host-1', is_hype_target: false },
    { id: 'a4', submission_id: 'sub-other', activated_at: iso(now), host_id: 'host-2', is_hype_target: true });
  x.rest.project_hype.push({ submission_id: 'sub-9', hype_bar: 350 });
  x.rest.hype_plays.push({ id: 'p9', submission_id: 'sub-9', host_id: 'host-1', start_bar: 0, end_bar: null, started_at: iso(now - 600000), ended_at: null });
  x.rest.submissions_public.push({ id: 'sub-9', title: 'Site Title', album_artwork_url: COVER, attachment_urls: [] });
  x.feed.update({ connected: false, target: null, hold: null });            // TikTok was never connected; the controller knows no song
  assert.ok(await until(() => x.sent.length && x.feed.message().onAir === true, 3000), 'on air without TikTok');
  assert.equal(x.feed.message().song.id, 'sub-9', 'the hype target, not the newest row and not another host\'s');
  assert.ok(await until(() => x.last().song && x.last().song.cover === COVER && x.last().hype.taps === 350 && x.last().song.title === 'Site Title', 3000), JSON.stringify(x.last()));
  for (const c of x.reads('active_projects')) { assert.equal(c.method, 'GET'); assert.equal(c.apikey, true); assert.match(c.query, /host_id=eq\.host-1/); assert.match(c.query, /order=activated_at\.desc/); assert.match(c.query, /limit=5/); }
  // no hype target: the newest row
  x.rest.active_projects[1].is_hype_target = false;
  assert.ok(await until(() => x.feed.message().song && x.feed.message().song.id === 'sub-new', 3000), 'no hype target: the newest');
  // nothing active: off air (and it is said)
  x.rest.active_projects.length = 0;
  assert.ok(await until(() => x.last().onAir === false && x.last().song === null, 3000), 'off air');
  const n = x.reads('active_projects').length;
  assert.ok(await until(() => x.reads('active_projects').length >= n + 2, 2000), 'still looking for the next song');
  assert.equal(x.mock.state.calls.length, 0, 'no LIVE Link endpoint was called by the feed');
  assert.ok(x.mock.state.restCalls.every((c) => c.method === 'GET'));
});

test('2.3.1 the controller\'s target is used until the direct read answers; then the site\'s own table wins; a new target from the controller is taken at once again', async (t) => {
  const x = await setup(t, { opts: { hostId: () => 'host-1' } });
  x.mock.state.restFail = (table) => (table === 'active_projects' ? { status: 503 } : null);       // the direct read does not answer yet
  x.feed.update({ connected: false, target: SONG, hold: null });
  assert.equal(x.sent[0].onAir, true, 'said at once from the controller\'s target, TikTok or not');
  assert.equal(x.sent[0].song.id, 'sub-1');
  assert.ok(await until(() => x.reads('active_projects').length >= 2));
  assert.equal(x.feed.message().song.id, 'sub-1', 'no answer yet: the controller\'s target stays');
  x.rest.active_projects.push({ id: 'a1', submission_id: 'sub-2', activated_at: iso(x.now()), host_id: 'host-1', is_hype_target: true });
  x.mock.state.restFail = null;
  assert.ok(await until(() => x.feed.message().song && x.feed.message().song.id === 'sub-2', 4000), 'answered: the site\'s table wins');
  x.feed.update({ connected: false, target: SONG, hold: null });            // the same target said again changes nothing
  assert.equal(x.feed.message().song.id, 'sub-2');
  x.rest.active_projects[0].submission_id = 'sub-3';
  x.feed.update({ connected: true, target: { submission_id: 'sub-3', title: 'Third' }, hold: null });   // a NEW target (a push answer): at once
  assert.deepEqual([x.last().song.id, x.last().song.title], ['sub-3', 'Third']);
  // hold ('show' / 'song') still forces off air, whatever the table says
  for (const hold of ['show', 'song']) {
    x.feed.update({ connected: true, target: { submission_id: 'sub-3', title: 'Third' }, hold });
    assert.equal(x.last().onAir, false, hold);
    await wait(120);
    assert.equal(x.feed.message().onAir, false, `${hold}: stays off air`);
    x.feed.update({ connected: true, target: { submission_id: 'sub-3', title: 'Third' }, hold: null });
    assert.equal(x.last().onAir, true);
  }
});

test('2.3.1 no host id known (an older site answer) or an odd one: the controller\'s target alone, TikTok or not; active_projects is never asked', async (t) => {
  for (const hostId of [undefined, () => null, () => '../x', () => { throw new Error('boom'); }]) {
    const x = await setup(t, { opts: hostId ? { hostId } : {} });
    x.rest.active_projects.push({ id: 'a1', submission_id: 'sub-2', activated_at: iso(x.now()), host_id: 'host-1', is_hype_target: true });
    x.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 42 });
    x.rest.hype_plays.push({ id: 'p1', submission_id: 'sub-1', host_id: 'host-1', start_bar: 0, end_bar: null, started_at: iso(x.now() - 600000), ended_at: null });
    x.feed.update({ connected: false, target: SONG, hold: null });
    assert.ok(await until(() => x.sent.length && x.last().hype.taps === 42, 3000));
    assert.equal(x.last().song.id, 'sub-1');
    assert.equal(x.reads('active_projects').length, 0);
    x.feed.stop();
  }
});

test('2.3.1 no VTuber listening: active_projects is not read either; the TikTok LIVE dropping changes nothing for the show state', async (t) => {
  let wanted = false;
  const x = await setup(t, { wanted: () => wanted, opts: { hostId: () => 'host-1' } });
  x.rest.active_projects.push({ id: 'a1', submission_id: 'sub-1', activated_at: iso(x.now()), host_id: 'host-1', is_hype_target: true });
  x.feed.update({ connected: true, target: null, hold: 'song' });
  x.feed.update({ connected: true, target: SONG, hold: null });
  await wait(200);
  assert.equal(x.reads().length, 0, 'no VTuber: the site is left alone');
  wanted = true;
  assert.ok(await until(() => x.reads('active_projects').length >= 2 && x.last() && x.last().onAir, 3000));
  const n = x.sent.length;
  x.feed.update({ connected: false, target: SONG, hold: null });            // the TikTok LIVE drops
  await wait(150);
  assert.equal(x.feed.message().onAir, true, 'still on air');
  assert.ok(x.sent.slice(n).every((m) => m.onAir === true && m.song.id === 'sub-1'), 'nothing said "off air"');
  const r = x.reads('project_hype').length;
  assert.ok(await until(() => x.reads('project_hype').length >= r + 2, 2000), 'the bar is still read');
});

// ---------------------------------------------------------------- 2.3.1: the song's finish (DONE / ADD TO AI RADIO) and the verdict word

const ZERO_HYPE = { taps: 0, rank: 0, label: 'Tap to hype it up', mythic: 0 };
// a song on air for host-1, as the site's tables say it (no TikTok anywhere in these tests)
function putOnAir(x, id = 'sub-1', { title = 'Test Song', cover = COVER, status = 'in_progress', ago = 5000 } = {}) {
  const at = x.now() - ago;
  x.rest.active_projects.push({ id: 'a-' + id, submission_id: id, activated_at: iso(at), host_id: 'host-1', is_hype_target: true });
  x.rest.project_hype.push({ submission_id: id, hype_bar: 10 });
  x.rest.hype_plays.push({ id: 'p-' + id, submission_id: id, host_id: 'host-1', start_bar: 0, end_bar: null, started_at: iso(at), ended_at: null });
  x.rest.submissions_public.push({ id, title, album_artwork_url: cover, attachment_urls: [], status, played_at: null });
  return at;
}
const offAirRow = (x, id = 'sub-1') => { const i = x.rest.active_projects.findIndex((r) => r.submission_id === id); if (i >= 0) x.rest.active_projects.splice(i, 1); };
// the site's DONE button: off air + status 'played' + played_at now
function pressDone(x, id = 'sub-1') { offAirRow(x, id); const s = x.rest.submissions_public.find((r) => r.id === id); s.status = 'played'; s.played_at = iso(x.now()); }
// each finish the VTuber was told of, once (a finish stays in the message for a while: the same one is not counted twice)
const finishes = (x) => [...new Map(x.sent.filter((m) => m.finish).map((m) => [`${m.finish.id}|${m.finish.kind}|${m.finish.at}`, m.finish])).values()];
const statusReads = (x) => x.reads('submissions_public').filter((c) => /select=id%2Cstatus%2Cplayed_at|select=id,status,played_at/.test(c.query));
const eatSetup = (t, opts = {}) => setup(t, { opts: { hostId: () => 'host-1', ...opts } });

test('2.3.1 DONE: the song leaves the air with status "played" -> one finish { id, kind: "played", at }, sent with the song and its cover, kept for a while, then cleared', async (t) => {
  const x = await eatSetup(t);
  putOnAir(x);
  x.feed.update({ connected: false, target: null, hold: null });
  assert.ok(await until(() => x.last() && x.last().onAir && x.last().song.cover === COVER && x.reads('radio_tracks').length >= 1, 3000));
  assert.ok(x.sent.every((m) => m.finish === null && m.grade === null), 'on air: no finish, no word');
  assert.equal(statusReads(x).length, 0, 'the status is not asked while the song is on air');
  const before = x.now();
  pressDone(x);
  assert.ok(await until(() => x.last().finish, 3000), 'the finish reached the message');
  const m = x.last();
  assert.deepEqual({ ...m, at: 0, finish: { ...m.finish, at: 0 } }, { v: 2, type: 'show', onAir: false, song: { id: 'sub-1', title: 'Test Song', cover: COVER }, hype: ZERO_HYPE, score: null,
    grade: null, finish: { id: 'sub-1', kind: 'played', at: 0 }, at: 0 });
  assert.ok(Number.isInteger(m.finish.at) && m.finish.at >= before && m.finish.at <= x.now(), 'at = when it was seen (ms)');
  assert.ok(await until(() => x.last().finish === null && x.last().song === null, 3000), 'kept for its time, then cleared');
  await wait(200);
  assert.equal(finishes(x).length, 1, 'exactly one finish');
  for (const c of statusReads(x)) { assert.equal(c.method, 'GET'); assert.match(c.query, /id=eq\.sub-1/); }
  assert.ok(statusReads(x).length >= 1 && statusReads(x).length <= 3);
  assert.ok(x.mock.state.restCalls.every((c) => c.method === 'GET' && c.apikey), 'reads only');
  assert.equal(x.mock.state.calls.length, 0, 'no LIVE Link endpoint was called');
});

test('2.3.1 ADD TO AI RADIO then DONE for the same song (and DONE then the radio): exactly one finish', async (t) => {
  // the radio first
  const x = await eatSetup(t);
  putOnAir(x);
  x.rest.radio_tracks.push({ submission_id: 'other-song', preview_only: false });
  x.feed.update({ connected: false, target: null, hold: null });
  assert.ok(await until(() => x.reads('radio_tracks').length >= 2, 3000));
  assert.ok(x.sent.every((m) => m.finish === null), 'another song\'s radio row is not this song\'s');
  for (const c of x.reads('radio_tracks')) { assert.equal(c.method, 'GET'); assert.match(c.query, /submission_id=eq\.sub-1/); assert.match(c.query, /limit=1/); }
  assert.ok(x.reads('radio_tracks').length <= x.reads('project_hype').length / 2 + 1, 'the radio is asked every 2nd read');
  x.rest.radio_tracks.push({ submission_id: 'sub-1', preview_only: false });
  assert.ok(await until(() => x.last().finish, 3000));
  assert.deepEqual([x.last().finish.id, x.last().finish.kind, x.last().onAir, x.last().song.id], ['sub-1', 'radio', true, 'sub-1'], 'the song is still on air');
  pressDone(x);
  assert.ok(await until(() => x.last().onAir === false, 3000));
  await wait(250);
  assert.deepEqual(finishes(x).map((f) => [f.id, f.kind]), [['sub-1', 'radio']], 'DONE after the radio: no second finish');
  assert.equal(statusReads(x).length, 0, 'already finished: the status is not even asked');
  // DONE first, then the radio button
  const y = await eatSetup(t);
  putOnAir(y);
  y.feed.update({ connected: false, target: null, hold: null });
  assert.ok(await until(() => y.last() && y.last().onAir && y.reads('radio_tracks').length >= 1, 3000));
  pressDone(y);
  assert.ok(await until(() => y.last().finish, 3000));
  y.rest.radio_tracks.push({ submission_id: 'sub-1', preview_only: false });
  await wait(300);
  assert.deepEqual(finishes(y).map((f) => [f.id, f.kind]), [['sub-1', 'played']]);
  // ... and the same song flickering back on air (the same airing, the row seen again) does not finish twice
  y.rest.active_projects.push({ id: 'a-again', submission_id: 'sub-1', activated_at: iso(y.now()), host_id: 'host-1', is_hype_target: true });
  assert.ok(await until(() => y.last().onAir === true, 3000));
  offAirRow(y);
  assert.ok(await until(() => y.last().onAir === false, 3000));
  await wait(250);
  assert.equal(finishes(y).length, 1, 'one finish per song');
});

test('2.3.1 the radio: a song that was ALREADY in the AI radio when it went on air does not finish by it; a preview-only row is not "added" until it goes live', async (t) => {
  const x = await eatSetup(t);
  putOnAir(x);
  x.rest.radio_tracks.push({ submission_id: 'sub-1', preview_only: false });       // from an earlier show
  x.feed.update({ connected: false, target: null, hold: null });
  assert.ok(await until(() => x.reads('radio_tracks').length >= 3, 3000));
  assert.ok(x.sent.every((m) => m.finish === null), 'no eat at the song\'s start for an old radio row');
  pressDone(x);
  assert.ok(await until(() => x.last().finish, 3000));
  assert.equal(x.last().finish.kind, 'played', 'DONE still finishes it');
  const y = await eatSetup(t);
  putOnAir(y);
  y.rest.radio_tracks.push({ submission_id: 'sub-1', preview_only: true });
  y.feed.update({ connected: false, target: null, hold: null });
  assert.ok(await until(() => y.reads('radio_tracks').length >= 3, 3000));
  assert.ok(y.sent.every((m) => m.finish === null), 'preview only: not in the radio yet');
  y.rest.radio_tracks[0].preview_only = false;
  assert.ok(await until(() => y.last().finish, 3000));
  assert.equal(y.last().finish.kind, 'radio');
});

test('2.3.1 CLEARED without DONE and without the radio: no finish, no word; an old "played" from an earlier show is not a finish either; a failing status read is no finish', async (t) => {
  const x = await eatSetup(t);
  putOnAir(x);
  x.feed.update({ connected: false, target: null, hold: null });
  assert.ok(await until(() => x.last() && x.last().onAir && x.reads('radio_tracks').length >= 1, 3000));
  offAirRow(x);                                                                    // cleared: the status stays as it was
  assert.ok(await until(() => x.last().onAir === false, 3000));
  assert.ok(await until(() => statusReads(x).length === 3, 3000), 'the status is looked at three times (the site writes it a moment after the song leaves)');
  await wait(200);
  assert.equal(statusReads(x).length, 3, 'and no more');
  assert.equal(finishes(x).length, 0);
  assert.ok(x.sent.every((m) => m.finish === null && m.grade === null));
  // the song was played in an earlier show (status 'played', played_at long before this airing), put on air again, then cleared
  const y = await eatSetup(t);
  const at = putOnAir(y, 'sub-1', { status: 'played' });
  y.rest.submissions_public[0].played_at = iso(at - 86400000);
  y.feed.update({ connected: false, target: null, hold: null });
  assert.ok(await until(() => y.last() && y.last().onAir && y.reads('hype_plays').length >= 1, 3000));
  offAirRow(y);
  assert.ok(await until(() => statusReads(y).length === 3, 3000));
  await wait(100);
  assert.equal(finishes(y).length, 0, 'yesterday\'s "played" is not today\'s DONE');
  // the site does not answer the status read
  const z = await eatSetup(t);
  putOnAir(z);
  z.feed.update({ connected: false, target: null, hold: null });
  assert.ok(await until(() => z.last() && z.last().onAir && z.last().song.cover === COVER, 3000));
  z.mock.state.restFail = (table) => (table === 'submissions_public' ? { status: 503 } : null);
  pressDone(z);
  assert.ok(await until(() => statusReads(z).length === 3, 3000));
  await wait(100);
  assert.equal(finishes(z).length, 0);
  assert.equal(z.last().onAir, false);
});

test('2.3.1 the verdict WORD travels with the score: fire / gem / solid / promising (lower case); a letter grade has a score and no word', async (t) => {
  for (const [given, word, score] of [['gem', 'gem', 82], [' Fire ', 'fire', 95], ['SOLID', 'solid', 60], ['promising', 'promising', 38], ['A', null, 88]]) {
    const x = await eatSetup(t);
    const at = putOnAir(x);
    x.feed.update({ connected: false, target: null, hold: null });
    assert.ok(await until(() => x.reads('ranking_board').length >= 1, 3000));
    assert.ok(x.sent.every((m) => m.grade === null && m.score === null));
    x.rest.ranking_board.push({ submission_id: 'sub-1', host_id: 'host-1', host_grade: given, reviewed_at: iso(at + 1000) });
    assert.ok(await until(() => x.last().score === score, 3000), `${given}: ${JSON.stringify(x.last())}`);
    assert.equal(x.last().grade, word, given);
    assert.ok(x.sent.every((m) => (m.score === null) === (m.grade === null) || word === null), 'the word and the score arrive together');
    // DONE: the verdict already given stays with the finish (the Mask can spit it at once)
    pressDone(x);
    assert.ok(await until(() => x.last().finish, 3000));
    assert.deepEqual([x.last().onAir, x.last().song.id, x.last().score, x.last().grade, x.last().finish.kind], [false, 'sub-1', score, word, 'played']);
    x.feed.stop();
  }
  assert.deepEqual(['fire', 'gem', 'solid', 'promising', ' GEM ', 'A', 's', 'great', null, 'constructor'].map(F.gradeWord), ['fire', 'gem', 'solid', 'promising', 'gem', null, null, null, null, null]);
});

test('2.3.1 a verdict given AFTER the finish reaches the message within the wait (looks at 1.5 / 5 / 10 / 20 s; here 60 / 160 / 300 / 450 ms); with the next song on air it is dropped', async (t) => {
  assert.deepEqual([F.LATE_GRADE_MS, F.FINISH_GRADE_MS, F.FINISH_SHOW_MS], [[1500, 5000], [10000, 20000], 20000], 'the real numbers');
  const x = await eatSetup(t, { finishGradeMs: [300, 450], finishShowMs: 3000, lateScoreShowMs: 600 });
  putOnAir(x);
  x.feed.update({ connected: false, target: null, hold: null });
  assert.ok(await until(() => x.last() && x.last().onAir && x.reads('ranking_board').length >= 1 && x.last().song.cover === COVER, 3000));
  pressDone(x);
  assert.ok(await until(() => x.last().finish, 3000));
  await wait(220);                                                                 // past the two early looks
  assert.equal(x.last().grade, null);
  x.rest.ranking_board.push({ submission_id: 'sub-1', host_id: 'host-1', host_grade: 'fire', reviewed_at: iso(x.now()) });
  assert.ok(await until(() => x.last().grade === 'fire', 3000), 'found by a later look');
  const m = x.last();
  assert.deepEqual({ ...m, at: 0, finish: { ...m.finish, at: 0 } }, { v: 2, type: 'show', onAir: false, song: { id: 'sub-1', title: 'Test Song', cover: COVER }, hype: ZERO_HYPE, score: 95,
    grade: 'fire', finish: { id: 'sub-1', kind: 'played', at: 0 }, at: 0 });
  assert.equal(finishes(x).length, 1);
  // cleared without DONE: only the two early looks (2.3.0's), not the long wait
  const y = await eatSetup(t, { finishGradeMs: [300, 450], finishShowMs: 3000 });
  putOnAir(y);
  y.feed.update({ connected: false, target: null, hold: null });
  assert.ok(await until(() => y.last() && y.last().onAir && y.reads('ranking_board').length >= 1, 3000));
  offAirRow(y);
  assert.ok(await until(() => y.last().onAir === false, 3000));
  const asked = y.reads('ranking_board').length;
  await wait(600);
  assert.equal(y.reads('ranking_board').length, asked + 2, 'two looks, as before');
  // the NEXT song goes on air during the wait: the old song's verdict is never said (the Mask gulps)
  const z = await eatSetup(t, { finishGradeMs: [300, 450], finishShowMs: 3000 });
  putOnAir(z);
  z.feed.update({ connected: false, target: null, hold: null });
  assert.ok(await until(() => z.last() && z.last().onAir && z.reads('ranking_board').length >= 1, 3000));
  pressDone(z);
  putOnAir(z, 'sub-2', { title: 'Next Song', ago: 0 });
  assert.ok(await until(() => z.last().onAir && z.last().song.id === 'sub-2' && z.last().finish, 3000), 'the next song is on air, the finish of the last one still said');
  assert.deepEqual([z.last().finish.id, z.last().finish.kind], ['sub-1', 'played']);
  z.rest.ranking_board.push({ submission_id: 'sub-1', host_id: 'host-1', host_grade: 'fire', reviewed_at: iso(z.now()) });
  await wait(600);
  assert.ok(z.sent.every((m) => m.grade === null && m.score === null), 'no word during another artist\'s song');
  assert.equal(finishes(z).length, 1);
});

test('2.3.1 the show message is still the 2.3.0 one: v 2, every old field as before, grade + finish only ADDED; the vendored VTuber reads it', async (t) => {
  // the 2.3.0 shapes (test/v8-show-feed.test.js at cacb502), field for field
  const OLD = {
    offAir: { v: 2, type: 'show', onAir: false, song: null, hype: ZERO_HYPE, score: null, at: 0 },
    onAir: { v: 2, type: 'show', onAir: true, song: { id: 'sub-1', title: 'Test Song', cover: COVER }, hype: { taps: 350, rank: 2, label: 'Heating Up', mythic: 0 }, score: null, at: 0 },
    late: { v: 2, type: 'show', onAir: false, song: { id: 'sub-1', title: 'Test Song', cover: COVER }, hype: ZERO_HYPE, score: 95, at: 0 },
  };
  const old = (m) => { const o = { ...m, at: 0 }; delete o.grade; delete o.finish; return o; };
  const x = await setup(t);                                                        // as 2.3.0 ran it: no host id, the controller's target
  x.feed.update({ connected: true, target: null, hold: 'song' });
  assert.deepEqual(old(x.last()), OLD.offAir);
  assert.deepEqual(Object.keys(x.last()).sort(), ['at', 'finish', 'grade', 'hype', 'onAir', 'score', 'song', 'type', 'v']);
  assert.deepEqual([x.last().grade, x.last().finish], [null, null]);
  x.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 350 });
  x.rest.hype_plays.push({ id: 'p1', submission_id: 'sub-1', host_id: 'host-1', start_bar: 0, end_bar: null, started_at: iso(x.now() - 600000), ended_at: null });
  x.rest.submissions_public.push({ id: 'sub-1', title: 'Test Song', album_artwork_url: COVER, attachment_urls: [] });
  x.feed.update(onAir());
  assert.ok(await until(() => x.last().hype.taps === 350 && x.last().song.cover === COVER, 3000));
  assert.deepEqual(old(x.last()), OLD.onAir);
  x.feed.update({ connected: true, target: null, hold: 'song' });
  x.rest.ranking_board.push({ submission_id: 'sub-1', host_id: 'host-1', host_grade: 'fire', reviewed_at: iso(x.now()) });
  assert.ok(await until(() => x.last().score === 95, 3000));
  assert.deepEqual(old(x.last()), OLD.late);
  assert.equal(x.last().grade, 'fire');
  // the VTuber in this install (2.3.0's files, or a later one): a message with the new fields is taken, its old fields unchanged
  const wire = require('../vendor/vtuber/js/mask-wire.js');
  const full = { ...OLD.late, at: 1795000000000, grade: 'fire', finish: { id: 'sub-1', kind: 'played', at: 1795000000000 } };
  const read = wire.cleanShow(full);
  assert.ok(read, 'not refused');
  assert.deepEqual({ type: read.type, onAir: read.onAir, song: { id: read.song.id, title: read.song.title }, hype: read.hype, score: read.score, at: read.at },
    { type: 'show', onAir: false, song: { id: 'sub-1', title: 'Test Song' }, hype: { taps: 0, rank: 0, label: '', mythic: 0 }, score: 95, at: 1795000000000 });
  assert.ok(wire.cleanShow({ ...full, v: 3 }) === null, 'which is why the version stays 2');
});

// ---------------------------------------------------------------- with the real controller (as main.js wires it)

test('wired as in the app: the controller\'s own state (the site\'s push answer) drives the feed; the show state reaches a v2 VTuber in the app; the song going off air is said at once', async (t) => {
  const fs = require('fs'), os = require('os'), path = require('path'), EventEmitter = require('events');
  const { TikTokLink } = require('../src/core/tiktok-link');
  const { VtuberLink } = require('../src/core/vtuber-link');
  const { LiveLinkApi } = require('../src/core/api');
  const { Controller } = require('../src/core/controller');
  const { Store } = require('../src/core/store');
  const made = [];
  class TikTokLiveConnection extends EventEmitter {
    constructor() { super(); made.push(this); }
    async connect() { setImmediate(() => this.emit('connected', { roomId: 'R1' })); return { roomId: 'R1' }; }
    disconnect() {}
  }
  const lib = { TikTokLiveConnection, UserOfflineError: class extends Error {}, SignatureRateLimitError: class extends Error {},
    ControlEvent: { CONNECTED: 'connected', DISCONNECTED: 'disconnected', ERROR: 'error', WEBSOCKET_DATA: 'websocketData' },
    WebcastEvent: { LIKE: 'like', ROOM_USER: 'roomUser', STREAM_END: 'streamEnd', GIFT: 'gift', CHAT: 'chat', FOLLOW: 'follow', SHARE: 'share', SOCIAL: 'social' } };
  const mock = createMock({ pushIntervalMs: 50, idlePushIntervalMs: 50, autoApprove: true });
  const port = await mock.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-v8-feed-'));
  const store = new Store({ dir });
  const link = new TikTokLink({ lib, setInterval: () => ({}), clearInterval: () => {} });
  const api = new LiveLinkApi({ baseUrl: `http://127.0.0.1:${port}/functions/v1/`, apiKey: 'test-publishable-key', getToken: () => store.getToken() });
  const ctl = new Controller({ api, link, store, appVersion: '1.0.0', deviceName: 'TEST-PC' });
  const got = [];
  const direct = Object.assign((ev) => { got.push(ev); return true; }, { v: 2 });
  const vt = new VtuberLink({ http: false, direct: () => direct }).attach(link);
  const feed = new ShowFeed({ restBase: `http://127.0.0.1:${port}/rest/v1/`, apiKey: 'test-publishable-key', coverHosts: [SITE], pollMs: 40, tickMs: 15,
    send: (m) => vt.sendShow(m), wanted: () => vt.canControl, hostId: () => (ctl && ctl.cfg && ctl.cfg.host_id) || null });   // main.js, word for word
  ctl.on('state', (s) => feed.update({ connected: s.connected, target: s.target, hold: s.hold }));   // main.js, word for word
  t.after(async () => { feed.stop(); vt.stop(); try { ctl.stop && ctl.stop(); } catch {} link.stop(); await mock.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  mock.state.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 350 });
  mock.state.rest.hype_plays.push({ id: 'p1', submission_id: 'sub-1', host_id: 'host-1', start_bar: 0, end_bar: null, started_at: iso(Date.now() - 600000), ended_at: null });
  mock.state.rest.submissions_public.push({ id: 'sub-1', title: 'Test Song', album_artwork_url: COVER, attachment_urls: [] });
  // 2.3.1: the site's own table says the same song is on air for this host (the id the site's config answer names)
  mock.state.rest.active_projects.push({ id: 'a1', submission_id: 'sub-1', activated_at: iso(Date.now() - 600000), host_id: 'host-1', is_hype_target: true });
  await ctl.pair('TEST2345');
  const shows = () => got.filter((e) => e.type === 'show');
  const last = () => shows()[shows().length - 1];
  assert.ok(await until(() => shows().length && last().onAir && last().hype.taps === 350 && last().song.cover === COVER, 6000), `last ${JSON.stringify(last())}`);
  assert.deepEqual({ ...last(), at: 0 }, { v: 2, type: 'show', onAir: true, song: { id: 'sub-1', title: 'Test Song', cover: COVER }, hype: { taps: 350, rank: 2, label: 'Heating Up', mythic: 0 }, score: null, grade: null, finish: null, at: 0 });
  // the site takes the song off air: its next push answer says target null
  made[0].emit('like', { count: 3, total: '50' });
  mock.state.target = null; mock.state.rest.active_projects.length = 0;
  made[0].emit('like', { count: 3, total: '53' });
  assert.ok(await until(() => last().onAir === false, 6000), 'off air reached the VTuber');
  assert.deepEqual([last().song, last().hype.rank], [null, 0]);
  // only GETs of the public tables left the feed; the device token was never sent to them
  assert.ok(mock.state.restCalls.length > 0 && mock.state.restCalls.every((c) => c.method === 'GET' && c.apikey));
  // 2.3.1: the song on air was asked for THIS host (host_id from the site's live-link-config answer), and only for it
  const air = mock.state.restCalls.filter((c) => c.table === 'active_projects');
  assert.ok(air.length >= 1 && air.every((c) => /host_id=eq\.host-1(&|$)/.test(c.query)), 'active_projects read for the paired host');
});

test('main.js keeps the rules: a test run never takes a real key, the keys are given back on quit, the feed reads only the site named by the app\'s own settings', () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /showFeed\.update\(\{ connected: s\.connected, target: s\.target, hold: s\.hold \}\)/);
  assert.match(main, /register: TEST_RUN \? \(\) => true : \(acc, fn\) => globalShortcut\.register\(acc, fn\)/);
  assert.match(main, /app\.on\('will-quit', \(\) => \{ try \{ if \(puppetKeys\) puppetKeys\.release\(\); \}/);
  assert.match(main, /restBase = new URL\(API_BASE\)\.origin \+ '\/rest\/v1\/'/);
  assert.match(main, /apiKey: SITE\.publishableKey, coverHosts: coverHosts\(SITE\.apiBase\)/);
  assert.ok(main.includes('send: (m) => vtuber.sendShow(m), wanted: () => vtuber.canControl, hostId: () => (ctl && ctl.cfg && ctl.cfg.host_id) || null });'), '2.3.1: the host whose song on air is read = the one this computer is paired to (the site\'s own config answer)');
  assert.ok(main.includes('const k = { canControl: !!(vtuber && vtuber.canControl), enabled: vtuberOn(), inApp: !!(vtHost && vtHost.running), vt: vtHost ? vtHost.vt : null };'), 'the keys follow the chosen character');
  assert.ok(main.includes('puppetKeys.setWanted(puppetWanted(k));'), 'the puppet keys: the Mask + its Puppet show switch');
  assert.ok(main.includes('puppetKeys.setEatWanted(eatWanted(k));'), '2.3.1 EAT IT: the Mask, whatever its Puppet show switch says');
  assert.match(main, /const \{ PuppetKeys, puppetWanted, eatWanted, /);
  assert.ok(main.includes('onChange: () => { syncPuppetKeys(); if (showFeed && vtuber && vtuber.canControl) showFeed.nudge(); }'), 'a VTuber that starts listening gets the state at once');
});

test('fix round: when a VTuber starts listening, the current state is sent at once (not at the next 5 s beat)', async (t) => {
  const x = await setup(t);
  x.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 42 });
  x.rest.hype_plays.push({ id: 'p1', submission_id: 'sub-1', host_id: 'host-1', start_bar: 0, end_bar: null, started_at: iso(x.now() - 600000), ended_at: null });
  x.feed.update(onAir());
  assert.ok(await until(() => x.last().hype.taps === 42, 2000));
  await wait(100);
  const n = x.sent.length;
  await wait(200);
  assert.equal(x.sent.length, n, 'unchanged: quiet until the 5 s beat');
  x.feed.nudge();
  assert.equal(x.sent.length, n + 1, 'nudged: sent now');
  assert.deepEqual({ ...x.last(), at: 0 }, { ...x.sent[n - 1], at: 0 });
  // 2.3.1: the TikTok LIVE dropping changes nothing: the song is still on air and a nudge still sends it
  x.feed.update({ connected: false, target: SONG, hold: null });
  assert.equal(x.sent.length, n + 1, 'the LIVE dropped: nothing new to say');
  x.feed.nudge();
  assert.equal(x.sent.length, n + 2);
  assert.equal(x.last().onAir, true);
  x.feed.stop();
  x.feed.nudge();
  assert.equal(x.sent.length, n + 2, 'stopped: a nudge sends nothing');
});
