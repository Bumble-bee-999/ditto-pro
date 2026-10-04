'use strict';
/* Ditto Pro — voice-over: records the microphone while the timeline plays and drops the take on an audio track.
   Nothing leaves the computer: the recording is written to the app's own folder as a WAV file. */
const Voice = (() => {
  let rec = null;   // { stream, mr, chunks, startAt, ctx, analyser, raf }

  async function start(o) {
    if (rec) return false;
    o = o || {};
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This computer has no microphone the app can use.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    const type = ['audio/webm;codecs=opus', 'audio/webm'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!type) { stream.getTracks().forEach((t) => t.stop()); throw new Error('Recording is not available here.'); }
    const mr = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 256000 });
    const chunks = [];
    mr.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) chunks.push(e.data); });
    rec = { stream, mr, chunks, startAt: S.playhead, level: 0 };
    // input level for the meter
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = ctx.createAnalyser(); an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      const tick = () => { if (!rec) return; an.getFloatTimeDomainData(buf); let p = 0; for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i])); rec.level = p; if (o.onLevel) o.onLevel(p); rec.raf = requestAnimationFrame(tick); };
      rec.ctx = ctx; tick();
    } catch (e) { /* the meter is optional */ }
    mr.start(250);
    if (o.play !== false) Player.play();
    return true;
  }

  // stops, saves, and places the take where recording began. Returns the new clip (or null).
  async function stop() {
    if (!rec) return null;
    const r = rec;
    Player.stop();
    await new Promise((res) => { r.mr.addEventListener('stop', res, { once: true }); try { r.mr.stop(); } catch (e) { res(); } });
    rec = null;
    if (r.raf) cancelAnimationFrame(r.raf);
    r.stream.getTracks().forEach((t) => t.stop());
    if (r.ctx) r.ctx.close().catch(() => {});
    const blob = new Blob(r.chunks, { type: 'audio/webm' });
    if (blob.size < 200) throw new Error('Nothing was recorded.');
    const res = await window.ditto.saveVoice({ data: new Uint8Array(await blob.arrayBuffer()) });
    if (!res || !res.ok) throw new Error((res && res.error) || 'The recording could not be saved.');
    const m = App.registerMedia([res.media])[0] || S.project.media.find((x) => x.path === res.media.path);
    if (!m) return null;
    S.checkpoint();
    let tr = S.freeTrackFor('audio', r.startAt, m.duration);
    if (!tr) { S.addTrack('audio'); tr = S.freeTrackFor('audio', r.startAt, m.duration); }
    const c = DS.newClip({ track: tr.id, media: m.id, start: r.startAt, in: 0, dur: Math.max(0.1, m.duration), label: m.name });
    S.project.clips.push(c);
    S.setSelection([c.id]);
    S.change(true);
    S.seek(r.startAt);
    return c;
  }
  function cancel() {
    if (!rec) return;
    const r = rec; rec = null;
    Player.stop();
    try { r.mr.stop(); } catch (e) { /* ignore */ }
    if (r.raf) cancelAnimationFrame(r.raf);
    r.stream.getTracks().forEach((t) => t.stop());
    if (r.ctx) r.ctx.close().catch(() => {});
  }

  function open() {
    Player.stop();
    const meter = el('i');
    const status = el('div', { class: 'dim', text: 'Recording starts at the playhead. The timeline plays while you speak; wear headphones so the playback is not recorded too.' });
    const mute = el('input', { type: 'checkbox' });
    let t0 = 0, timer = null, wasMuted = null;
    const dlg = modal({
      title: 'Record voice-over', width: 480, dismissable: false,
      body: [status, el('div', { class: 'progress', style: 'margin:10px 0' }, [meter]), el('label', { class: 'chk' }, [mute, el('span', { text: 'Silence the timeline while recording' })])],
      buttons: [
        { label: 'Close', onClick: () => { cancel(); clearInterval(timer); restore(); } },
        { label: 'Record', primary: true, keepOpen: true, onClick: async ({ close, btn }) => {
          if (!rec) {
            try {
              if (mute.checked) { wasMuted = S.project.tracks.map((t) => [t, t.mute]); S.project.tracks.forEach((t) => { t.mute = true; }); }
              await start({ onLevel: (p) => { meter.style.width = Math.min(100, Math.round(p * 140)) + '%'; } });
              t0 = Date.now(); btn.textContent = 'Stop'; mute.disabled = true;
              timer = setInterval(() => { status.textContent = 'Recording… ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s'; }, 100);
            } catch (e) { restore(); toast('Could not start recording: ' + (e.name === 'NotAllowedError' ? 'the microphone is blocked (check Windows privacy settings).' : e.name === 'NotFoundError' ? 'no microphone was found.' : e.message), 'err', 7000); }
          } else {
            clearInterval(timer); btn.disabled = true; status.textContent = 'Saving…';
            try { const c = await stop(); restore(); close(); toast(c ? 'Voice-over added to ' + c.track + '.' : 'The recording could not be placed.', c ? 'ok' : 'err'); }
            catch (e) { restore(); close(); toast('Voice-over failed: ' + e.message, 'err', 7000); }
          }
        } }
      ]
    });
    function restore() { if (wasMuted) { wasMuted.forEach(([t, m]) => { t.mute = m; }); wasMuted = null; S.change(true); } }
    void dlg;
  }

  return { open, start, stop, cancel, recording: () => !!rec };
})();
