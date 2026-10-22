'use strict';
// 2.0.8: the back-up recorder page (hidden). Records the stream window the app chose (main.js answers the browser's
// screen-share request with that window, so no picker appears) with the computer's audio, and hands the file over
// to the app piece by piece (one every second). Nothing is shown; nothing is kept here.
(function () {
  const bridge = window.captureBridge;
  if (!bridge) return;
  const MIMES = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4',
    'video/webm;codecs=h264,opus', 'video/webm;codecs=h264',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  let rec = null, streams = [], t0 = 0, bytes = 0, done = false, timer = null;

  function end(info) {
    if (done) return;
    done = true;
    clearInterval(timer);
    for (const s of streams) { try { s.getTracks().forEach((t) => t.stop()); } catch {} }
    streams = [];
    bridge.ended(info || {});
  }

  bridge.onStart(async ({ timesliceMs = 1000, audio = 'system', videoBitsPerSecond = 6000000 } = {}) => {
    if (rec) return;
    let display;
    try {
      // The app's handler picks the window (and the system's audio on Windows). On a Mac the system audio can't be
      // captured this way: the microphone is added instead (what the host says is what the clips need most).
      display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: audio === 'system' });
    } catch (e) { end({ error: `screen capture refused: ${e && e.message}` }); return; }
    streams.push(display);
    const tracks = [...display.getVideoTracks()];
    let audioTracks = display.getAudioTracks();
    if (!audioTracks.length && audio !== 'none') {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
        streams.push(mic);
        audioTracks = mic.getAudioTracks();
        bridge.log('audio: microphone (system audio not available)');
      } catch (e) { bridge.log(`audio: none (${e && e.message})`); }
    }
    const stream = new MediaStream([...tracks, ...audioTracks]);
    const mime = MIMES.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
    try {
      rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond, audioBitsPerSecond: 128000 });
    } catch (e) { end({ error: `recorder: ${e && e.message}` }); return; }
    rec.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      const mediaMs = Math.round(performance.now() - t0);
      ev.data.arrayBuffer().then((buf) => { bytes += buf.byteLength; bridge.chunk(buf, { mediaMs, bytes }); }).catch(() => {});
    };
    rec.onerror = (ev) => end({ error: `recorder error: ${(ev && ev.error && ev.error.message) || 'unknown'}` });
    rec.onstop = () => end({});
    const v = tracks[0];
    if (v) v.addEventListener('ended', () => end({ error: 'the window closed (or sharing stopped)' }));
    const settings = v ? v.getSettings() : {};
    t0 = performance.now();
    try { rec.start(timesliceMs); } catch (e) { end({ error: `recorder start: ${e && e.message}` }); return; }
    bridge.started({ mime: rec.mimeType || mime, width: settings.width || null, height: settings.height || null, audio: audioTracks.length ? (display.getAudioTracks().length ? 'system' : 'microphone') : 'none' });
    // A recorder that stops handing over data (a stalled encoder) is reported, so the app can start over.
    let lastBytes = 0, still = 0;
    timer = setInterval(() => { if (bytes === lastBytes) { if (++still >= 20) end({ error: 'no data from the screen recorder for 20 s' }); } else { still = 0; lastBytes = bytes; } }, 1000);
  });

  bridge.onStop(() => {
    if (rec && rec.state !== 'inactive') { try { rec.requestData(); } catch {} try { rec.stop(); } catch { end({}); } }
    else end({});
  });
})();
