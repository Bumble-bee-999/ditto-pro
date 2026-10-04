'use strict';
/* Ditto Pro — CMX 3600 EDL writer (one event list per sequence: V events from video tracks, A events from audio tracks).
   Cuts only: dissolves are written as "D" with the transition length when the incoming clip has one. */
const pad = (n, w) => String(n).padStart(w || 2, '0');
function tc(sec, fps) {
  const rate = Math.round(fps);
  let f = Math.max(0, Math.round(sec * fps));
  const h = Math.floor(f / (rate * 3600)); f -= h * rate * 3600;
  const m = Math.floor(f / (rate * 60)); f -= m * rate * 60;
  const s = Math.floor(f / rate); f -= s * rate;
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ':' + pad(f);
}
const reelOf = (name, used) => {
  let r = String(name || 'AX').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) || 'AX';
  return r;
};
const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ');
function exportEDL(project) {
  const fps = project.fps || 30;
  const media = {}; (project.media || []).forEach((m) => { media[m.id] = m; });
  const out = ['TITLE: ' + clean(project.name || 'Untitled'), 'FCM: NON-DROP FRAME', ''];
  let n = 0;
  const trackOrder = (project.tracks || []).slice().sort((a, b) => (a.type === b.type ? 0 : a.type === 'video' ? -1 : 1));
  for (const t of trackOrder) {
    const cl = (project.clips || []).filter((c) => c.track === t.id && c.type === 'media' && media[c.media] && !c.disabled).sort((a, b) => a.start - b.start);
    for (const c of cl) {
      const m = media[c.media];
      if (t.type === 'audio' && m.hasAudio === false) continue;
      const chan = t.type === 'video' ? 'V' : 'A';
      const sIn = c.in || 0, sOut = sIn + c.dur * (c.speed || 1);
      const dis = c.tr && c.tr.type === 'dissolve' && c.tr.dur > 0;
      n++;
      out.push(pad(n, 3) + '  ' + reelOf(m.name).padEnd(8) + ' ' + chan.padEnd(4) + ' ' + (dis ? 'D    ' + pad(Math.round(c.tr.dur * fps), 3) : 'C       ') + ' ' + tc(sIn, fps) + ' ' + tc(sOut, fps) + ' ' + tc(c.start, fps) + ' ' + tc(c.start + c.dur, fps));
      out.push('* FROM CLIP NAME: ' + clean(m.name));
      if (m.path) out.push('* SOURCE FILE: ' + clean(m.path));
      if ((c.speed || 1) !== 1) out.push('* NOTE: speed ' + (c.speed * 100).toFixed(2) + '%');
      out.push('');
    }
  }
  return out.join('\r\n');
}
module.exports = { exportEDL, tc };
