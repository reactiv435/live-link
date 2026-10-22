'use strict';
// Picks the stream links to record from a TikTok answer: room info (`webcast/room/info`, data.stream_url), the LIVE page
// (liveRoomUserInfo.liveRoom.streamData) or the api-live answer (data.liveRoom.streamData).
// TikTok lists the same LIVE at several qualities, each as FLV and HLS. The source quality ("origin") comes first;
// H.264 is preferred over H.265 because every browser can play it, so a full review copied without re-encoding plays on
// the site. Every usable link is returned in order, so the recorder can fall back to the next one when one fails.
// 2.0.8: a multi-guest / co-host LIVE may list its mixed picture under data.multi_stream_url instead (same shape as
// stream_url); the room's flags (age-restricted, subscribers-only, paid, region-blocked, LIVE Studio/OBS, multi-guest)
// are read out too, for the "why no video" verdict and session.json.

const QUALITY_ORDER = ['origin', 'uhd_60', 'uhd', 'hd_60', 'hd', 'sd', 'md', 'ld'];
const SKIP_QUALITIES = new Set(['ao']);      // audio only
const FLV_ORDER = ['FULL_HD1', 'HD1', 'SD1', 'SD2'];

const isLink = (u) => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length < 4000;
const isObj = (v) => !!v && typeof v === 'object';

function parseJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

// "1080x1920" -> { width: 1080, height: 1920 }
function parseResolution(r) {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(r || ''));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function liveRoomOf(roomInfo) {
  const d = roomInfo.data || roomInfo;
  return (roomInfo.liveRoomUserInfo && roomInfo.liveRoomUserInfo.liveRoom) || roomInfo.liveRoom || (isObj(d) && d.liveRoom) || null;
}

// The "stream_url"-shaped objects of a room-info answer: data.stream_url, and data.multi_stream_url for a multi-guest /
// co-host LIVE (the mixed picture TikTok composes for viewers).
function streamUrlsOf(roomInfo) {
  if (!isObj(roomInfo)) return [];
  const d = roomInfo.data || roomInfo;
  if (!isObj(d)) return [];
  return [d.stream_url, d.multi_stream_url].filter((su) => isObj(su) && Object.keys(su).length);
}

// The "pull data" (every quality, codec, resolution) sits in different places depending on where it came from:
// room/info (data.stream_url.live_core_sdk_data, data.multi_stream_url.live_core_sdk_data), the LIVE page / api-live
// (liveRoom.streamData, and an H.265 copy in liveRoom.hevcStreamData).
function pullData(roomInfo) {
  if (!isObj(roomInfo)) return { pulls: [], sus: [] };
  const sus = streamUrlsOf(roomInfo);
  const liveRoom = liveRoomOf(roomInfo);
  const pulls = [];
  const add = (p, hevc) => { if (isObj(p)) pulls.push({ pull: p, hevc }); };
  for (const su of sus) {
    if (isObj(su.live_core_sdk_data)) add(su.live_core_sdk_data.pull_data, false);
    if (isObj(su.pull_data)) add(su.pull_data, false);
  }
  if (isObj(liveRoom)) {
    add(isObj(liveRoom.streamData) && liveRoom.streamData.pull_data, false);
    add(isObj(liveRoom.hevcStreamData) && liveRoom.hevcStreamData.pull_data, true);
    add(isObj(liveRoom.multiStreamData) && liveRoom.multiStreamData.pull_data, false);
  }
  return { pulls, sus };
}

const orderedKeys = (obj, first) => [...first.filter((k) => k in obj), ...Object.keys(obj).filter((k) => !first.includes(k))];

// Every usable link, best first: [{ url, kind: 'flv'|'hls', quality, codec, width?, height? }].
function streamCandidates(roomInfo) {
  const { pulls, sus } = pullData(roomInfo);
  const out = [], seen = new Set();
  const push = (c) => { if (!isLink(c.url) || seen.has(c.url)) return; seen.add(c.url); out.push(c); };
  const sdk = [];
  for (const { pull, hevc } of pulls) {
    const streamData = parseJson(pull.stream_data);
    const qualities = streamData && isObj(streamData.data) ? streamData.data : null;
    if (!qualities) continue;
    for (const q of orderedKeys(qualities, QUALITY_ORDER)) {
      if (SKIP_QUALITIES.has(q)) continue;
      const main = isObj(qualities[q]) && qualities[q].main;
      if (!isObj(main)) continue;
      const params = parseJson(main.sdk_params) || {};
      const codec = String(params.VCodec || params.vcodec || (hevc ? 'h265' : '')).toLowerCase() || null;
      const res = parseResolution(params.resolution) || {};
      // FLV first: a live FLV starts at once and survives a hiccup better than HLS's playlist reloads.
      for (const kind of ['flv', 'hls']) if (isLink(main[kind])) sdk.push({ url: main[kind], kind, quality: q, codec, ...res });
    }
  }
  for (const c of sdk) if (!c.codec || c.codec === 'h264') push(c);
  for (const c of sdk) if (c.codec && c.codec !== 'h264') push(c);
  for (const su of sus) {
    const flv = isObj(su.flv_pull_url) ? su.flv_pull_url : {};
    for (const q of orderedKeys(flv, FLV_ORDER)) push({ url: flv[q], kind: 'flv', quality: q, codec: null });
    push({ url: su.rtmp_pull_url, kind: 'flv', quality: 'default', codec: null });
    const hls = isObj(su.hls_pull_url_map) ? su.hls_pull_url_map : {};
    for (const q of orderedKeys(hls, FLV_ORDER)) push({ url: hls[q], kind: 'hls', quality: q, codec: null });
    push({ url: su.hls_pull_url, kind: 'hls', quality: 'default', codec: null });
  }
  // The sign server's room info (fetched from ITS network): data.room_info with plain flv/hls links (+ a low-quality pair).
  const ri = eulerRoomOf(roomInfo);
  if (ri) {
    push({ url: ri.flv_pull_url, kind: 'flv', quality: 'default', codec: null });
    push({ url: ri.hls_pull_url, kind: 'hls', quality: 'default', codec: null });
    push({ url: ri.flv_pull_url_ld, kind: 'flv', quality: 'ld', codec: null });
    push({ url: ri.hls_pull_url_ld, kind: 'hls', quality: 'ld', codec: null });
  }
  return out;
}

// The sign server's answer shape ({ ok, code, data: { room_info: { status, is_live, flv_pull_url... }, user } }).
function eulerRoomOf(roomInfo) {
  if (!isObj(roomInfo)) return null;
  const d = isObj(roomInfo.data) ? roomInfo.data : roomInfo;
  return isObj(d) && isObj(d.room_info) && ('is_live' in d.room_info || 'flv_pull_url' in d.room_info || 'hls_pull_url' in d.room_info) ? d.room_info : null;
}

// The best link, with the others as `alternates` (the recorder tries them when one fails), or null.
function pickStream(roomInfo) {
  const all = streamCandidates(roomInfo);
  return all.length ? { ...all[0], alternates: all.slice(1) } : null;
}

// What kind of LIVE this is and who may watch it, from a room-info / LIVE page / api-live answer. Everything here is a
// plain flag (no links, no names), for the verdict and session.json. Missing fields read as false / null.
function roomFlags(roomInfo) {
  const d = (isObj(roomInfo) && (isObj(roomInfo.data) ? roomInfo.data : roomInfo)) || {};
  const room = (isObj(roomInfo) && liveRoomOf(roomInfo)) || {};
  const age = isObj(d.age_restricted) ? d.age_restricted : null;
  const paid = isObj(d.paid_event) ? d.paid_event : isObj(room.paidEvent) ? room.paidEvent : null;
  const region = isObj(d.regional_restricted) ? d.regional_restricted : null;
  const mic = isObj(d.link_mic) ? d.link_mic : null;
  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  return {
    ageRestricted: !!(age && (age.restricted === true || Number(age.AgeInterval) > 0)),
    subOnly: Number(d.live_sub_only) > 0 || Number(room.liveSubOnly) > 0,
    paidEvent: !!(paid && (Number(paid.paid_type) > 0 || Number(paid.event_id) > 0)),
    gated: d.is_gated_room === true,
    regionBlocked: !!(region && Array.isArray(region.block_list) && region.block_list.length > 0),
    thirdParty: d.live_type_third_party === true,       // TikTok LIVE Studio, OBS or another stream-key tool
    audioOnly: d.live_type_audio === true,
    multiGuest: d.live_type_linkmic === true || d.with_linkmic === true || !!(mic && Array.isArray(mic.linked_user_list) && mic.linked_user_list.length > 0),
    multiStream: Number(d.multi_stream_scene) > 0 || Number(room.multiStreamScene) > 0,
    mode: num(d.live_room_mode !== undefined ? d.live_room_mode : room.liveRoomMode),
    status: num(d.status !== undefined ? d.status : room.status !== undefined ? room.status : (isObj(d.user) && d.user.status !== undefined) ? d.user.status
      : (eulerRoomOf(roomInfo) ? (eulerRoomOf(roomInfo).status !== undefined ? eulerRoomOf(roomInfo).status : (eulerRoomOf(roomInfo).is_live === false ? 4 : 2)) : undefined)),
  };
}

// Why an answer carried no stream link: { code, status?, text } for the log and session.json (no links, no tokens).
//   restricted     = room info answered status_code 4003110 with no data. TikTok gives that for a LIVE it won't show a
//                    signed-out viewer: an age-restricted (18+) LIVE, and also a LIVE that has ended;
//   tiktok_error   = another non-zero status code;
//   ended          = the room's status is 4 (the LIVE is over);
//   sub_only / paid / gated / region = the answer describes the LIVE and says who may watch it (and lists no links);
//   no_stream_data = the answer describes the LIVE but lists no video links (or none usable).
function whyNoStream(roomInfo) {
  if (!isObj(roomInfo)) return { code: 'empty', text: 'empty answer' };
  const sc = Number(roomInfo.status_code !== undefined ? roomInfo.status_code : roomInfo.statusCode);
  const d = isObj(roomInfo.data) ? roomInfo.data : roomInfo;
  const msg = String((isObj(d) && (d.message || d.prompts)) || roomInfo.message || '').replace(/https?:\/\/\S+/g, '<link>').slice(0, 120);
  if (sc === 4003110) return { code: 'restricted', status: sc, text: `TikTok answered status 4003110 with no video (a LIVE it only shows to signed-in viewers, e.g. 18+)${msg ? `: ${msg}` : ''}` };
  if (sc) return { code: 'tiktok_error', status: sc, text: `TikTok answered status ${sc}${msg ? `: ${msg}` : ''}` };
  // The sign server said no (its own code/message: not TikTok's).
  if ('ok' in roomInfo && (roomInfo.ok === false || !isObj(roomInfo.data))) {
    return { code: 'tiktok_error', status: Number(roomInfo.code) || null, text: `the sign server answered ${roomInfo.code !== undefined ? `code ${roomInfo.code}` : 'no data'}${msg ? `: ${msg}` : ''}` };
  }
  const f = roomFlags(roomInfo);
  if (f.status === 4) return { code: 'ended', status: 4, text: 'TikTok says this LIVE has ended (status 4)' };
  if (f.subOnly) return { code: 'sub_only', text: 'TikTok says this LIVE is for subscribers only (no video for other viewers)' };
  if (f.paidEvent) return { code: 'paid', text: 'TikTok says this LIVE is a paid event (no video without a ticket)' };
  if (f.gated) return { code: 'gated', text: 'TikTok says this LIVE is gated (no video for a signed-out viewer)' };
  if (f.regionBlocked) return { code: 'region', text: 'TikTok says this LIVE is blocked in some regions' };
  const { pulls, sus } = pullData(roomInfo);
  if (pulls.length || sus.length || eulerRoomOf(roomInfo)) return { code: 'no_stream_data', text: 'the answer has video fields but no usable link' };
  return { code: 'no_stream_data', text: 'the answer has no video links' };
}

module.exports = { pickStream, streamCandidates, whyNoStream, roomFlags, parseResolution, eulerRoomOf };
