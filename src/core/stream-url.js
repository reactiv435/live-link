'use strict';
// Picks the stream links to record from a TikTok answer: room info (`webcast/room/info`, data.stream_url), the LIVE page
// (liveRoomUserInfo.liveRoom.streamData) or the api-live answer (data.liveRoom.streamData).
// TikTok lists the same LIVE at several qualities, each as FLV and HLS. The source quality ("origin") comes first;
// H.264 is preferred over H.265 because every browser can play it, so a full review copied without re-encoding plays on
// the site. Every usable link is returned in order, so the recorder can fall back to the next one when one fails.

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

// The "pull data" (every quality, codec, resolution) sits in different places depending on where it came from:
// room/info (data.stream_url.live_core_sdk_data), the LIVE page / api-live (liveRoom.streamData, and an H.265 copy in
// liveRoom.hevcStreamData).
function pullData(roomInfo) {
  if (!isObj(roomInfo)) return { pulls: [], su: null };
  const d = roomInfo.data || roomInfo;
  const su = isObj(d) && isObj(d.stream_url) ? d.stream_url : null;
  const liveRoom = liveRoomOf(roomInfo);
  const pulls = [];
  const add = (p, hevc) => { if (isObj(p)) pulls.push({ pull: p, hevc }); };
  if (su && isObj(su.live_core_sdk_data)) add(su.live_core_sdk_data.pull_data, false);
  if (isObj(liveRoom)) {
    add(isObj(liveRoom.streamData) && liveRoom.streamData.pull_data, false);
    add(isObj(liveRoom.hevcStreamData) && liveRoom.hevcStreamData.pull_data, true);
  }
  return { pulls, su };
}

const orderedKeys = (obj, first) => [...first.filter((k) => k in obj), ...Object.keys(obj).filter((k) => !first.includes(k))];

// Every usable link, best first: [{ url, kind: 'flv'|'hls', quality, codec, width?, height? }].
function streamCandidates(roomInfo) {
  const { pulls, su } = pullData(roomInfo);
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
  if (su) {
    const flv = isObj(su.flv_pull_url) ? su.flv_pull_url : {};
    for (const q of orderedKeys(flv, FLV_ORDER)) push({ url: flv[q], kind: 'flv', quality: q, codec: null });
    push({ url: su.rtmp_pull_url, kind: 'flv', quality: 'default', codec: null });
    const hls = isObj(su.hls_pull_url_map) ? su.hls_pull_url_map : {};
    for (const q of orderedKeys(hls, FLV_ORDER)) push({ url: hls[q], kind: 'hls', quality: q, codec: null });
    push({ url: su.hls_pull_url, kind: 'hls', quality: 'default', codec: null });
  }
  return out;
}

// The best link, with the others as `alternates` (the recorder tries them when one fails), or null.
function pickStream(roomInfo) {
  const all = streamCandidates(roomInfo);
  return all.length ? { ...all[0], alternates: all.slice(1) } : null;
}

// Why an answer carried no stream link: { code, status?, text } for the log and session.json (no links, no tokens).
//   restricted     = room info answered status_code 4003110 with no data. TikTok gives that for a LIVE it won't show a
//                    signed-out viewer: an age-restricted (18+) LIVE, and also a LIVE that has ended;
//   tiktok_error   = another non-zero status code;
//   ended          = the room's status is 4 (the LIVE is over);
//   no_stream_data = the answer describes the LIVE but lists no video links (or none usable).
function whyNoStream(roomInfo) {
  if (!isObj(roomInfo)) return { code: 'empty', text: 'empty answer' };
  const sc = Number(roomInfo.status_code !== undefined ? roomInfo.status_code : roomInfo.statusCode);
  const d = isObj(roomInfo.data) ? roomInfo.data : roomInfo;
  const msg = String((isObj(d) && (d.message || d.prompts)) || roomInfo.message || '').replace(/https?:\/\/\S+/g, '<link>').slice(0, 120);
  if (sc === 4003110) return { code: 'restricted', status: sc, text: 'TikTok answered status 4003110 with no video (a LIVE it only shows to signed-in viewers, e.g. 18+)' };
  if (sc) return { code: 'tiktok_error', status: sc, text: `TikTok answered status ${sc}${msg ? `: ${msg}` : ''}` };
  const room = liveRoomOf(roomInfo);
  const raw = (isObj(room) && room.status !== undefined) ? room.status : (isObj(d) && d.status !== undefined) ? d.status : (isObj(d) && isObj(d.user) ? d.user.status : undefined);
  if (Number(raw) === 4) return { code: 'ended', status: 4, text: 'TikTok says this LIVE has ended (status 4)' };
  const { pulls, su } = pullData(roomInfo);
  if (pulls.length || su) return { code: 'no_stream_data', text: 'the answer has video fields but no usable link' };
  return { code: 'no_stream_data', text: 'the answer has no video links' };
}

module.exports = { pickStream, streamCandidates, whyNoStream, parseResolution };
