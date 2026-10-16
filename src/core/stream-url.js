'use strict';
// Picks the best stream link to record from TikTok's room info (the `webcast/room/info` answer the connector keeps).
// TikTok lists the same LIVE at several qualities. The source quality ("origin") comes first; H.264 is preferred over
// H.265 because every browser can play it, so a full review copied without re-encoding plays on the site.

const QUALITY_ORDER = ['origin', 'uhd', 'hd', 'sd', 'ld'];
const FLV_ORDER = ['FULL_HD1', 'HD1', 'SD1', 'SD2'];

const isLink = (u) => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length < 4000;

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

// The same "pull data" (every quality, codec, resolution) sits in different places depending on where it came from:
// room/info (data.stream_url.live_core_sdk_data), the LIVE page (liveRoomUserInfo.liveRoom.streamData) or the
// api-live answer (data.liveRoom.streamData).
function pullData(roomInfo) {
  if (!roomInfo || typeof roomInfo !== 'object') return { pull: null, su: null };
  const d = roomInfo.data || roomInfo;
  const su = d && d.stream_url && typeof d.stream_url === 'object' ? d.stream_url : null;
  const liveRoom = (roomInfo.liveRoomUserInfo && roomInfo.liveRoomUserInfo.liveRoom) || roomInfo.liveRoom || (d && d.liveRoom) || null;
  const pull = (su && su.live_core_sdk_data && su.live_core_sdk_data.pull_data) || (liveRoom && liveRoom.streamData && liveRoom.streamData.pull_data) || null;
  return { pull, su };
}

function pickStream(roomInfo) {
  const { pull: sdk, su } = pullData(roomInfo);
  if (!sdk && !su) return null;

  // The SDK pull data lists every quality with its codec and resolution.
  const streamData = parseJson(sdk && sdk.stream_data);
  const qualities = streamData && streamData.data;
  if (qualities && typeof qualities === 'object') {
    const found = [];
    for (const q of QUALITY_ORDER) {
      const main = qualities[q] && qualities[q].main;
      if (!main) continue;
      const params = parseJson(main.sdk_params) || {};
      const url = isLink(main.flv) ? main.flv : isLink(main.hls) ? main.hls : null;
      if (!url) continue;
      const codec = String(params.VCodec || params.vcodec || '').toLowerCase() || null;
      found.push({ url, kind: isLink(main.flv) ? 'flv' : 'hls', quality: q, codec, ...(parseResolution(params.resolution) || {}) });
    }
    const h264 = found.find((f) => !f.codec || f.codec === 'h264');
    if (h264 || found.length) return h264 || found[0];
  }

  if (!su) return null;
  const flv = su.flv_pull_url || {};
  for (const q of FLV_ORDER) if (isLink(flv[q])) return { url: flv[q], kind: 'flv', quality: q, codec: null };
  if (isLink(su.rtmp_pull_url)) return { url: su.rtmp_pull_url, kind: 'flv', quality: 'default', codec: null };
  if (isLink(su.hls_pull_url)) return { url: su.hls_pull_url, kind: 'hls', quality: 'default', codec: null };
  return null;
}

module.exports = { pickStream, parseResolution };
