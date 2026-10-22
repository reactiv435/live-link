'use strict';
// 2.0.8: what the room answers say about a LIVE (who may watch it, what kind it is), the extra places a video link can
// sit (multi-guest, the sign server's room info), and the "why no video" codes for session.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const { streamCandidates, whyNoStream, roomFlags, eulerRoomOf } = require('../src/core/stream-url');

// Melanie's room info as TikTok answered it minutes after her LIVE (measured 2026-10-22 02:25Z; links stripped).
const MELANIE = { status_code: 0, data: {
  status: 4, age_restricted: { AgeInterval: 0, restricted: false, source: 0 }, live_sub_only: 0, paid_event: { event_id: 0, paid_type: 0 },
  is_gated_room: false, regional_restricted: { block_list: [] }, live_type_third_party: true, live_type_audio: false, live_type_linkmic: false,
  with_linkmic: false, live_room_mode: 6, multi_stream_scene: 0, link_mic: { linked_user_list: [], multi_guest_enable: false },
  stream_url: { flv_pull_url: { HD1: 'https://pull.example/hd1.flv' }, hls_pull_url: 'https://pull.example/hls.m3u8' } } };

test('room flags: age-restricted, subscribers-only, paid, gated, region, LIVE Studio/OBS, multi-guest, mode, status', () => {
  const f = roomFlags(MELANIE);
  assert.deepEqual(f, { ageRestricted: false, subOnly: false, paidEvent: false, gated: false, regionBlocked: false, thirdParty: true, audioOnly: false, multiGuest: false, multiStream: false, mode: 6, status: 4 });
  assert.equal(roomFlags({ data: { age_restricted: { AgeInterval: 18, restricted: true, source: 1 }, status: 2 } }).ageRestricted, true);
  assert.equal(roomFlags({ data: { age_restricted: { AgeInterval: 18, restricted: false, source: 0 } } }).ageRestricted, true, 'an age interval alone counts');
  assert.equal(roomFlags({ data: { live_sub_only: 1 } }).subOnly, true);
  assert.equal(roomFlags({ data: { liveRoom: { liveSubOnly: 1, status: 2 } } }).subOnly, true, 'api-live / LIVE page shape');
  assert.equal(roomFlags({ data: { paid_event: { event_id: 1234, paid_type: 1 } } }).paidEvent, true);
  assert.equal(roomFlags({ data: { is_gated_room: true } }).gated, true);
  assert.equal(roomFlags({ data: { regional_restricted: { block_list: ['XX'] } } }).regionBlocked, true);
  assert.equal(roomFlags({ data: { link_mic: { linked_user_list: [{ user_id: 1 }] } } }).multiGuest, true);
  assert.equal(roomFlags({ data: { with_linkmic: true } }).multiGuest, true);
  assert.equal(roomFlags({ data: { multi_stream_scene: 2 } }).multiStream, true);
  assert.equal(roomFlags({ data: { user: { status: 2 }, liveRoom: {} } }).status, 2);
  assert.deepEqual(roomFlags(null).mode, null);
  assert.deepEqual(roomFlags({ data: { prompts: '' }, status_code: 4003110 }).ageRestricted, false, 'a 4003110 answer carries no flags');
  assert.doesNotMatch(JSON.stringify(roomFlags(MELANIE)), /https?:/, 'flags never carry links');
});

test('why no video: subscribers-only / paid / gated / region are told apart from "no links"; 4003110 keeps TikTok\'s message', () => {
  assert.equal(whyNoStream({ status_code: 0, data: { status: 2, live_sub_only: 1 } }).code, 'sub_only');
  assert.equal(whyNoStream({ status_code: 0, data: { status: 2, paid_event: { paid_type: 1, event_id: 9 } } }).code, 'paid');
  assert.equal(whyNoStream({ status_code: 0, data: { status: 2, is_gated_room: true } }).code, 'gated');
  assert.equal(whyNoStream({ status_code: 0, data: { status: 2, regional_restricted: { block_list: ['US'] } } }).code, 'region');
  assert.equal(whyNoStream({ status_code: 0, data: { status: 2, live_sub_only: 0 } }).code, 'no_stream_data');
  const r = whyNoStream({ status_code: 4003110, data: { prompts: 'This LIVE is only for people 18 and older. See https://www.tiktok.com/x' } });
  assert.equal(r.code, 'restricted');
  assert.match(r.text, /18 and older/);
  assert.doesNotMatch(r.text, /tiktok\.com\/x/, 'links in TikTok\'s message are stripped');
  assert.equal(whyNoStream(MELANIE).code, 'ended', 'a finished LIVE with links left over still reads as ended');
});

test('multi-guest / co-host LIVEs: the mixed picture under multi_stream_url is used like stream_url', () => {
  const sd = (data) => ({ stream_data: JSON.stringify({ data }) });
  const room = { status_code: 0, data: { status: 2, stream_url: {}, multi_stream_url: {
    live_core_sdk_data: { pull_data: sd({ hd: { main: { flv: 'https://p/mix-hd.flv', hls: 'https://p/mix-hd.m3u8', sdk_params: JSON.stringify({ VCodec: 'h264', resolution: '720x1280' }) } } }) },
    flv_pull_url: { HD1: 'https://p/mix-old.flv' } } } };
  assert.deepEqual(streamCandidates(room).map((c) => c.url), ['https://p/mix-hd.flv', 'https://p/mix-hd.m3u8', 'https://p/mix-old.flv']);
  assert.equal(streamCandidates(room)[0].height, 1280);
  // an api-live answer with a multiStreamData copy
  const api = { data: { liveRoom: { status: 2, multiStreamData: { pull_data: sd({ origin: { main: { flv: 'https://p/ms.flv', sdk_params: '{}' } } }) } } } };
  assert.deepEqual(streamCandidates(api).map((c) => c.url), ['https://p/ms.flv']);
});

test('the sign server\'s room info (fetched from its own network): plain flv/hls links, its own "no" and "ended"', () => {
  const eu = { ok: true, code: 200, routes_attempted: ['api'], data: { raw: { _note: 'premium' }, unique_id: 'h', user: { nickname: 'x' },
    room_info: { status: 2, is_live: true, flv_pull_url: 'https://p/e.flv', hls_pull_url: 'https://p/e.m3u8', flv_pull_url_ld: 'https://p/e-ld.flv', hls_pull_url_ld: 'https://p/e-ld.m3u8' } } };
  assert.ok(eulerRoomOf(eu));
  assert.deepEqual(streamCandidates(eu).map((c) => [c.url, c.quality, c.kind]), [['https://p/e.flv', 'default', 'flv'], ['https://p/e.m3u8', 'default', 'hls'], ['https://p/e-ld.flv', 'ld', 'flv'], ['https://p/e-ld.m3u8', 'ld', 'hls']]);
  assert.equal(roomFlags(eu).status, 2);
  assert.equal(whyNoStream({ ok: true, code: 200, data: { room_info: { status: 4, is_live: false } } }).code, 'ended');
  assert.equal(whyNoStream({ ok: true, code: 200, data: { room_info: { is_live: false } } }).code, 'ended', 'is_live false with no status = over');
  const no = whyNoStream({ ok: false, code: 404, message: 'The user is not live.', data: null });
  assert.equal(no.code, 'tiktok_error');
  assert.match(no.text, /sign server answered code 404: The user is not live/);
  assert.equal(whyNoStream({ ok: true, code: 200, data: { room_info: { status: 2, is_live: true } } }).code, 'no_stream_data', 'live but no links (free tier?)');
  assert.equal(eulerRoomOf(MELANIE), null, 'a TikTok answer is not mistaken for the sign server\'s');
});
