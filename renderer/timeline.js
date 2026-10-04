'use strict';
/* Ditto Pro — multi-track timeline UI. */
function popupMenu(x, y, items) {
  $$('.ctxmenu').forEach((n) => n.remove());
  const m = el('div', { class: 'menu ctxmenu', style: 'position:fixed;z-index:300;left:' + x + 'px;top:' + y + 'px' });
  const drop = el('div', { class: 'drop', style: 'display:block' });
  items.forEach((it) => {
    if (it === '-') { drop.appendChild(el('div', { class: 'sep' })); return; }
    const row = el('div', { class: 'item' + (it.disabled ? ' disabled' : '') }, [el('span', { text: it.label }), it.key ? el('kbd', { text: it.key }) : null]);
    row.addEventListener('click', () => { m.remove(); it.run(); });
    drop.appendChild(row);
  });
  m.appendChild(drop);
  document.body.appendChild(m);
  const r = drop.getBoundingClientRect();
  if (r.right > innerWidth) m.style.left = Math.max(4, innerWidth - r.width - 6) + 'px';
  if (r.bottom > innerHeight) m.style.top = Math.max(4, innerHeight - r.height - 6) + 'px';
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off, true); } };
  setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
}

const Timeline = (() => {
  const TRACK_H = 54, RULER_H = 26;
  const scroll = $('#tlScroll'), content = $('#tlContent'), rulerEl = $('#ruler'), tracksEl = $('#tlTracks');
  const heads = $('#tlHeads'), ph = $('#playhead'), snapLine = $('#snapLine'), toolbar = $('#tlToolbar');
  const rulerCv = el('canvas');
  rulerEl.appendChild(rulerCv);
  const thumbStyle = el('style');
  document.head.appendChild(thumbStyle);
  const thumbRules = new Set();
  const waveRequested = new Set();
  let trackEls = {}; // id -> element
  let drag = null;

  // ---------------------------------------------------------------- toolbar
  const zoomRange = el('input', { type: 'range', min: 0, max: 100, step: 1, title: 'Zoom' });
  const toolBtns = {};
  function buildToolbar() {
    toolbar.innerHTML = '';
    toolBtns.select = ibtn('pointer', 'Selection tool (V)', () => setTool('select'));
    toolBtns.razor = ibtn('razor', 'Razor tool (C)', () => setTool('razor'));
    toolBtns.snap = ibtn('magnet', 'Snapping (S)', () => { S.snap = !S.snap; syncToolbar(); });
    toolBtns.undo = ibtn('undo', 'Undo (Ctrl+Z)', () => S.undo());
    toolBtns.redo = ibtn('redo', 'Redo (Ctrl+Shift+Z)', () => S.redo());
    toolBtns.marker = ibtn('flag', 'Add marker (M)', () => S.addMarker());
    toolBtns.addV = el('button', { class: 'btn', style: 'padding:2px 8px', text: '+ Video track', onclick: () => S.addTrack('video') });
    toolBtns.addA = el('button', { class: 'btn', style: 'padding:2px 8px', text: '+ Audio track', onclick: () => S.addTrack('audio') });
    toolBtns.zout = ibtn('zoom-out', 'Zoom out (-)', () => zoomBy(1 / 1.4));
    toolBtns.zin = ibtn('zoom-in', 'Zoom in (=)', () => zoomBy(1.4));
    toolBtns.fit = ibtn('fit', 'Fit sequence in view (\\)', () => fit());
    zoomRange.addEventListener('input', () => setZoom(sliderToZoom(+zoomRange.value)));
    const sep = () => el('div', { class: 'sep' });
    [toolBtns.select, toolBtns.razor, toolBtns.snap, sep(), toolBtns.undo, toolBtns.redo, sep(), toolBtns.marker, sep(), toolBtns.addV, toolBtns.addA,
      el('div', { class: 'grow' }), toolBtns.zout, zoomRange, toolBtns.zin, toolBtns.fit].forEach((n) => toolbar.appendChild(n));
    syncToolbar();
  }
  const sliderToZoom = (v) => 3 * Math.pow(200, v / 100);
  const zoomToSlider = (z) => Math.round(Math.log(z / 3) / Math.log(200) * 100);
  function syncToolbar() {
    toolBtns.select.classList.toggle('on', S.tool === 'select');
    toolBtns.razor.classList.toggle('on', S.tool === 'razor');
    toolBtns.snap.classList.toggle('on', S.snap);
    toolBtns.undo.classList.toggle('disabled', !S.undoStack.length);
    toolBtns.redo.classList.toggle('disabled', !S.redoStack.length);
    zoomRange.value = DS.clamp(zoomToSlider(S.zoom), 0, 100);
  }
  function setTool(t) { S.tool = t; syncToolbar(); render(); }

  // ---------------------------------------------------------------- zoom / scroll
  function setZoom(z, anchorTime, anchorPx) {
    z = DS.clamp(z, 3, 600);
    if (anchorTime == null) { anchorTime = S.playhead; anchorPx = S.playhead * S.zoom - scroll.scrollLeft; if (anchorPx < 0 || anchorPx > scroll.clientWidth) { anchorTime = (scroll.scrollLeft + scroll.clientWidth / 2) / S.zoom; anchorPx = scroll.clientWidth / 2; } }
    S.zoom = z;
    layout();
    scroll.scrollLeft = Math.max(0, anchorTime * z - anchorPx);
    drawRuler(); syncToolbar();
  }
  const zoomBy = (k) => setZoom(S.zoom * k);
  function fit() {
    const d = Math.max(S.duration(), 5);
    setZoom((scroll.clientWidth - 50) / d, 0, 0);
    scroll.scrollLeft = 0;
  }
  const xOf = (t) => t * S.zoom;
  const timeAt = (clientX) => Math.max(0, (clientX - scroll.getBoundingClientRect().left + scroll.scrollLeft) / S.zoom);

  function layout() {
    const w = Math.max(scroll.clientWidth, (S.duration() + 30) * S.zoom + 200);
    content.style.width = w + 'px';
    placePlayhead();
  }

  // ---------------------------------------------------------------- ruler
  const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200];
  function clockLabel(t, step) {
    const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    const ss = step < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + ss;
  }
  function drawRuler() {
    const vw = scroll.clientWidth, dpr = window.devicePixelRatio || 1;
    rulerCv.width = Math.ceil(vw * dpr); rulerCv.height = RULER_H * dpr;
    rulerCv.style.width = vw + 'px'; rulerCv.style.height = RULER_H + 'px';
    rulerCv.style.left = scroll.scrollLeft + 'px';
    const g = rulerCv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, vw, RULER_H);
    const step = STEPS.find((s) => s * S.zoom >= 78) || STEPS[STEPS.length - 1];
    const minor = step / (step >= 10 ? (step % 15 === 0 && step < 60 ? 3 : 5) : step === 0.1 ? 2 : step === 0.25 ? 5 : step === 0.5 ? 5 : step === 1 ? 4 : step === 2 ? 4 : 5);
    const t0 = scroll.scrollLeft / S.zoom, t1 = (scroll.scrollLeft + vw) / S.zoom;
    g.font = '10.5px Consolas, monospace'; g.textBaseline = 'top';
    for (let t = Math.floor(t0 / minor) * minor; t <= t1 + minor; t += minor) {
      const x = Math.round(t * S.zoom - scroll.scrollLeft) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      g.strokeStyle = major ? '#6b717c' : '#434852';
      g.beginPath(); g.moveTo(x, major ? 12 : 19); g.lineTo(x, RULER_H); g.stroke();
      if (major) { g.fillStyle = '#9aa0ab'; g.fillText(clockLabel(Math.round(t * 1000) / 1000, step), x + 4, 3); }
    }
  }
  function renderRulerExtras() {
    $$('.marker, .workarea', rulerEl).forEach((n) => n.remove());
    const wa = S.project.workArea;
    if (wa.in != null || wa.out != null) {
      const a = wa.in != null ? wa.in : 0, b = wa.out != null ? wa.out : Math.max(S.duration(), a);
      rulerEl.appendChild(el('div', { class: 'workarea', style: 'left:' + xOf(a) + 'px;width:' + Math.max(2, xOf(b - a)) + 'px' }));
    }
    S.project.markers.forEach((m) => {
      const label = (m.name ? m.name + ' — ' : '') + 'Marker ' + DS.fmtTC(m.t, S.project.fps) + (m.comments && m.comments.length ? ' · ' + m.comments.length + ' comment' + (m.comments.length > 1 ? 's' : '') : '') + (m.resolved ? ' (resolved)' : '');
      const n = el('div', { class: 'marker' + (m.resolved ? ' resolved' : '') + (m.comments && m.comments.length ? ' talk' : ''), style: 'left:' + xOf(m.t) + 'px', title: label + ' — double-click to comment, right-click for more' });
      n.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.button === 0) S.seek(m.t); });
      n.addEventListener('dblclick', (e) => { e.stopPropagation(); Review.focus(m.id); });
      n.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); popupMenu(e.clientX, e.clientY, [
        { label: 'Comment…', run: () => Review.focus(m.id) },
        { label: m.resolved ? 'Reopen' : 'Mark as resolved', run: () => S.resolveMarker(m.id, !m.resolved) },
        '-',
        { label: 'Delete marker', run: () => S.removeMarker(m.id) }]); });
      rulerEl.appendChild(n);
    });
  }

  // ---------------------------------------------------------------- tracks / clips
  function displayTracks() {
    const v = S.project.tracks.filter((t) => t.type === 'video').reverse();
    const a = S.project.tracks.filter((t) => t.type === 'audio');
    return { v, a };
  }
  function ensureThumbRule(m) {
    if (!m.thumb || thumbRules.has(m.id)) return;
    thumbRules.add(m.id);
    thumbStyle.appendChild(document.createTextNode('.th-' + m.id + '{background-image:url("' + m.thumb + '")}\n'));
  }
  function requestWave(m) {
    if (!m || !m.hasAudio || m.missing || waveRequested.has(m.id)) return;
    waveRequested.add(m.id);
    window.ditto.waveform(m.path).then((r) => {
      const rt = S.rtFor(m.id);
      rt.peaks = r.peaks; rt.perSec = r.perSec;
      render();
    }).catch(() => {});
  }
  function drawWave(cv, c, m, h) {
    const rt = S.rt[m.id];
    const w = cv.width = Math.min(3000, Math.max(1, Math.round(c.dur * S.zoom)));
    cv.height = h;
    if (!rt || !rt.peaks) return;
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(255,255,255,0.6)';
    const per = rt.perSec, peaks = rt.peaks, gain = Math.min(4, Math.pow(10, (c.vol || 0) / 20));
    for (let x = 0; x < w; x++) {
      const t0 = c.in + (x / w * c.dur) * c.speed, t1 = c.in + ((x + 1) / w * c.dur) * c.speed;
      const i0 = Math.floor(t0 * per), i1 = Math.max(i0 + 1, Math.ceil(t1 * per));
      let mx = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > mx) mx = peaks[i];
      const hh = Math.max(1, Math.min(h, mx / 255 * gain * h * 0.92));
      g.fillRect(x, (h - hh) / 2, 1, hh);
    }
  }

  function buildClip(c, track) {
    const m = c.type === 'media' ? S.media(c.media) : null;
    const isAudioTrack = track.type === 'audio';
    const cls = ['clip'];
    if (isAudioTrack) cls.push('audio');
    else if (c.type === 'title') cls.push('title');
    else if (c.type === 'adjust') cls.push('adjust');
    else if (m && m.kind === 'image') cls.push('image');
    if (S.sel.has(c.id)) cls.push('sel');
    if (m && m.missing) cls.push('missing');
    if (c.disabled) cls.push('disabled');
    if (S.tool === 'razor') cls.push('razor');
    const ext = S.analysis.ext[c.id] || 0;
    const n = el('div', { class: cls.join(' '), 'data-id': c.id, style: 'left:' + xOf(c.start) + 'px;width:' + Math.max(3, xOf(c.dur)) + 'px' });
    if (m && m.thumb && !isAudioTrack) { ensureThumbRule(m); n.appendChild(el('div', { class: 'thumbs th-' + m.id, style: 'background-size:auto 100%' })); }
    if (m && m.hasAudio && m.kind !== 'image') {
      requestWave(m);
      const cv = el('canvas', { class: 'wf', style: isAudioTrack ? '' : 'height:42%;top:auto;bottom:0;opacity:.8' });
      drawWave(cv, c, m, isAudioTrack ? TRACK_H - 6 : 20);
      n.appendChild(cv);
    }
    if (c.kf.vol && c.kf.vol.length > 1 && m && m.hasAudio) {
      // the volume "rubber band": −60 dB at the bottom of the clip, +12 dB at the top
      const W = Math.max(3, xOf(c.dur)), Hh = TRACK_H - 6, yOf = (db) => Hh - (DS.clamp(db, -60, 12) + 60) / 72 * Hh;
      const N = Math.min(400, Math.max(2, Math.round(W / 4))), pts = [];
      for (let i = 0; i <= N; i++) { const t = c.dur * i / N; pts.push((W * i / N).toFixed(1) + ',' + yOf(DS.volAt(c, t)).toFixed(1)); }
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'volband'); svg.setAttribute('width', W); svg.setAttribute('height', Hh);
      svg.setAttribute('style', 'position:absolute;left:0;top:3px;pointer-events:none');
      const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      pl.setAttribute('points', pts.join(' ')); pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', '#ffd35c'); pl.setAttribute('stroke-width', '1.5');
      svg.appendChild(pl); n.appendChild(svg);
    }
    if (c.tr && c.tr.dur > 0) n.appendChild(el('div', { class: 'trmark', style: 'width:' + Math.max(4, xOf(Math.min(c.tr.dur, c.dur))) + 'px', title: DS.TRANSITIONS[c.tr.type] || 'Transition' }));
    const label = c.type === 'title' ? ((c.title && c.title.text) || (c.title && c.title.shape && { matte: 'Colour matte', rect: 'Rectangle', ellipse: 'Ellipse' }[c.title.shape.kind]) || 'Title').split('\n')[0] : c.type === 'adjust' ? 'Adjustment Layer' : (m ? m.name : '(missing media)');
    n.appendChild(el('div', { class: 'cl', text: label }));
    const tags = [];
    if (Math.abs(c.speed - 1) > 0.001) tags.push(Math.round(c.speed * 100) + '%');
    if (DS.ALLPROPS.some((p) => c.kf[p] && c.kf[p].length)) tags.push('fx');
    if (c.mute) tags.push('muted');
    if (c.blend && c.blend !== 'normal' && !isAudioTrack) tags.push(DS.BLEND_MODES[c.blend] ? DS.BLEND_MODES[c.blend].split(' ')[0].toLowerCase() : '');
    if (tags.length) n.appendChild(el('div', { class: 'tag', text: tags.join(' · ') }));
    if (S.sel.has(c.id)) {
      const kfs = el('div', { class: 'kfs' });
      const seen = new Set();
      DS.ALLPROPS.forEach((p) => (c.kf[p] || []).forEach((k) => { const key = Math.round(k.t * 100); if (!seen.has(key) && k.t >= 0 && k.t <= c.dur) { seen.add(key); kfs.appendChild(el('i', { style: 'left:' + xOf(k.t) + 'px' })); } }));
      n.appendChild(kfs);
    }
    if (DS.cleanLabel(c.color)) n.appendChild(el('div', { class: 'clab', style: 'position:absolute;left:0;right:0;top:0;height:4px;pointer-events:none;background:' + DS.cleanLabel(c.color) }));
    n.appendChild(el('div', { class: 'hl' }));
    n.appendChild(el('div', { class: 'hr' }));
    void ext;
    return n;
  }

  function render() {
    const { v, a } = displayTracks();
    trackEls = {};
    tracksEl.innerHTML = '';
    heads.innerHTML = '';
    heads.appendChild(el('div', { class: 'hpad' }, [el('span', { class: 'dim', text: 'Tracks' })]));
    const addTrack = (t) => {
      const row = el('div', { class: 'track ' + t.type + (t.lock ? ' locked' : ''), 'data-track': t.id });
      S.trackClips(t.id).forEach((c) => row.appendChild(buildClip(c, t)));
      tracksEl.appendChild(row);
      trackEls[t.id] = row;
      const hd = el('div', { class: 'thead ' + t.type, 'data-track': t.id }, [el('div', { class: 'tn', text: t.name })]);
      if (t.type === 'video') hd.appendChild(ibtn(t.hidden ? 'eye-off' : 'eye', t.hidden ? 'Show track' : 'Hide track', () => S.toggleTrack(t.id, 'hidden'), t.hidden ? 'off' : ''));
      hd.appendChild(ibtn(t.mute ? 'volume-off' : 'volume', t.mute ? 'Unmute track' : 'Mute track', () => S.toggleTrack(t.id, 'mute'), t.mute ? 'off' : ''));
      hd.appendChild(ibtn('sliders', 'Track mixer: fader and effects for the whole track', () => Rack.open(t.id), DS.rackActive(t) ? 'lockon' : 'off'));
      hd.appendChild(ibtn(t.lock ? 'lock' : 'unlock', t.lock ? 'Unlock track' : 'Lock track', () => S.toggleTrack(t.id, 'lock'), t.lock ? 'lockon' : 'off'));
      hd.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        popupMenu(e.clientX, e.clientY, [{ label: 'Delete track ' + t.name, run: async () => { const n = S.project.clips.filter((c) => c.track === t.id).length; if (!n || await confirmDialog('Delete track', 'Delete track ' + t.name + ' and its ' + n + ' clip(s)?', 'Delete', true)) S.removeTrack(t.id); } }]);
      });
      heads.appendChild(hd);
    };
    v.forEach(addTrack);
    tracksEl.appendChild(el('div', { class: 'trackgap' }));
    heads.appendChild(el('div', { class: 'thead gap' }));
    a.forEach(addTrack);
    layout();
    renderRulerExtras();
    drawRuler();
    syncToolbar();
    heads.scrollTop = scroll.scrollTop;
  }

  function placePlayhead() {
    ph.style.left = xOf(S.playhead) + 'px';
  }
  function followPlayhead() {
    const x = xOf(S.playhead);
    if (S.playing && (x > scroll.scrollLeft + scroll.clientWidth - 30 || x < scroll.scrollLeft)) scroll.scrollLeft = Math.max(0, x - 80);
    else if (!S.playing && drag == null && (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth)) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
  }

  // ---------------------------------------------------------------- pointer interaction
  function trackUnder(clientY) {
    for (const id of Object.keys(trackEls)) {
      const r = trackEls[id].getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return S.track(id);
    }
    return null;
  }
  function showSnap(t) {
    if (t == null) { snapLine.classList.add('hidden'); return; }
    snapLine.classList.remove('hidden'); snapLine.style.left = xOf(t) + 'px';
  }

  tracksEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const clipEl = e.target.closest('.clip');
    if (!clipEl) {
      // empty space: deselect and start scrubbing
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) S.setSelection([]);
      startScrub(e);
      return;
    }
    const c = S.clip(clipEl.dataset.id);
    if (!c) return;
    const track = S.track(c.track);
    if (S.tool === 'razor') {
      if (track.lock) return;
      const t = S.snapTime(timeAt(e.clientX), new Set()).t;
      S.checkpoint();
      if (S.split(c.id, t)) S.change(true);
      return;
    }
    const onHandle = e.target.classList.contains('hl') || e.target.classList.contains('hr');
    const ctrl = e.ctrlKey || e.metaKey;
    // modifiers on a trim handle: Ctrl = ripple trim (later clips follow), Alt = roll the cut (the neighbour gives or takes)
    // Alt on the clip body = slip (the clip stays, its source moves)
    if (!onHandle && !e.altKey && (ctrl || e.shiftKey)) { S.setSelection([c.id], true); return; }
    if (!S.sel.has(c.id)) S.setSelection([c.id]);
    if (track.lock) return;
    let mode = e.target.classList.contains('hl') ? 'trimL' : e.target.classList.contains('hr') ? 'trimR' : 'move';
    if (mode === 'move' && e.altKey) mode = 'slip';
    const ids = mode === 'move' ? Array.from(S.sel) : [c.id];
    const orig = {};
    const keep = (k) => ({ start: k.start, track: k.track, in: k.in, dur: k.dur, kf: DS.clone(k.kf) });
    ids.forEach((id) => { orig[id] = keep(S.clip(id)); });
    drag = { mode, lead: c, ids, orig, sx: e.clientX, sy: e.clientY, moved: false, scrollX0: scroll.scrollLeft };
    if (onHandle && ctrl) {
      // ripple: remember where everything after this clip on the track started
      const end = DS.clipEnd(c);
      drag.ripple = S.project.clips.filter((k) => k !== c && k.track === c.track && k.start >= end - 1e-4).map((k) => ({ c: k, start: k.start }));
    } else if (onHandle && e.altKey) {
      // roll: the clip that touches this edge
      const nb = S.project.clips.find((k) => k !== c && k.track === c.track && (mode === 'trimR' ? Math.abs(k.start - DS.clipEnd(c)) < 1e-3 : Math.abs(DS.clipEnd(k) - c.start) < 1e-3));
      if (nb) drag.roll = { c: nb, o: keep(nb) };
    }
    scroll.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  rulerEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.classList.contains('marker')) return;
    startScrub(e);
  });
  function startScrub(e) {
    drag = { mode: 'scrub' };
    scroll.setPointerCapture(e.pointerId);
    if (S.playing) Player.stop();
    S.seek(timeAt(e.clientX));
  }

  scroll.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.mode === 'scrub') { S.seek(timeAt(e.clientX)); return; }
    const lead = drag.lead, o = drag.orig[lead.id];
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4) return;
      drag.moved = true; S.checkpoint();
    }
    const dx = (e.clientX - drag.sx + (scroll.scrollLeft - drag.scrollX0)) / S.zoom;
    const excl = new Set(drag.ids);
    if (drag.mode === 'move') {
      let ns = o.start + dx;
      const a = S.snapTime(ns, excl), b = S.snapTime(ns + lead.dur, excl);
      let hit = null;
      if (a.hit != null && (b.hit == null || Math.abs(a.t - ns) <= Math.abs(b.t - (ns + lead.dur)))) { ns = a.t; hit = a.hit; }
      else if (b.hit != null) { ns = b.t - lead.dur; hit = b.hit; }
      let delta = ns - o.start;
      const minStart = Math.min.apply(null, drag.ids.map((id) => drag.orig[id].start));
      delta = Math.max(delta, -minStart);
      showSnap(hit);
      // vertical track change (same media type only)
      const tu = trackUnder(e.clientY);
      let shift = 0;
      if (tu) {
        const type = S.track(o.track).type;
        if (tu.type === type) {
          const list = S.project.tracks.filter((t) => t.type === type);
          shift = list.findIndex((t) => t.id === tu.id) - list.findIndex((t) => t.id === o.track);
        }
      }
      drag.ids.forEach((id) => {
        const k = S.clip(id), oo = drag.orig[id];
        k.start = Math.round((oo.start + delta) * 1000) / 1000;
        const type = S.track(oo.track).type;
        const list = S.project.tracks.filter((t) => t.type === type);
        const idx = DS.clamp(list.findIndex((t) => t.id === oo.track) + shift, 0, list.length - 1);
        if (!list[idx].lock) k.track = list[idx].id; else k.track = oo.track;
      });
    } else if (drag.mode === 'slip') {
      // dragging right shows earlier source, like pulling the film under a fixed window
      lead.in = o.in; S.slipBy(lead, -dx);
      showSnap(null);
    } else if (drag.mode === 'trimL') {
      let ns = o.start + dx;
      const s = S.snapTime(ns, excl);
      if (s.hit != null && !drag.ripple) { ns = s.t; showSnap(s.hit); } else showSnap(null);
      const isSrc = (k) => k.type === 'media' && S.media(k.media) && S.media(k.media).kind !== 'image';
      const minStart = isSrc(lead) ? o.start - o.in / lead.speed : 0;
      let lo = Math.max(drag.ripple ? -1e9 : 0, minStart), hi = o.start + o.dur - 0.1;
      if (drag.roll) {   // the neighbour on the left grows or shrinks by the same amount
        const nb = drag.roll.c, no = drag.roll.o, nmax = S.maxDur(nb) === Infinity ? 1e6 : (S.media(nb.media).duration - no.in) / (nb.speed || 1);
        lo = Math.max(lo, no.start + 0.1); hi = Math.min(hi, no.start + nmax);
      }
      ns = DS.clamp(ns, lo, hi);
      const d = ns - o.start;
      lead.in = Math.max(0, o.in + d * lead.speed); lead.dur = o.dur - d;
      lead.kf = DS.clone(o.kf);
      DS.ALLPROPS.forEach((p) => lead.kf[p].forEach((k) => { k.t -= d; }));
      if (drag.ripple) { lead.start = o.start; drag.ripple.forEach((r) => { r.c.start = Math.max(0, r.start - d); }); }   // head trimmed in place, the rest closes up
      else lead.start = ns;
      if (drag.roll) drag.roll.c.dur = drag.roll.o.dur + d;
    } else if (drag.mode === 'trimR') {
      let ne = o.start + o.dur + dx;
      const s = S.snapTime(ne, excl);
      if (s.hit != null && !drag.ripple) { ne = s.t; showSnap(s.hit); } else showSnap(null);
      const max = S.maxDur(lead) === Infinity ? 1e6 : S.maxDur(lead);
      let lo = 0.1, hi = max;
      if (drag.roll) {   // the neighbour on the right starts later or earlier by the same amount
        const nb = drag.roll.c, no = drag.roll.o, src = nb.type === 'media' && S.media(nb.media) && S.media(nb.media).kind !== 'image';
        hi = Math.min(hi, o.dur + no.dur - 0.1); lo = Math.max(lo, src ? o.dur - no.in / (nb.speed || 1) : 0.1);
      }
      lead.dur = DS.clamp(ne - o.start, lo, hi);
      const d = lead.dur - o.dur;
      if (drag.ripple) drag.ripple.forEach((r) => { r.c.start = Math.max(0, r.start + d); });
      if (drag.roll) {
        const nb = drag.roll.c, no = drag.roll.o;
        nb.start = no.start + d; nb.in = Math.max(0, no.in + d * (nb.speed || 1)); nb.dur = no.dur - d;
        nb.kf = DS.clone(no.kf);
        DS.ALLPROPS.forEach((p) => nb.kf[p].forEach((k) => { k.t -= d; }));
      }
    }
    S.change();
  });

  const endPointer = () => {
    if (!drag) return;
    const d = drag; drag = null;
    showSnap(null);
    if (d.mode !== 'scrub' && d.moved) {
      if (!d.ripple && !d.roll && d.mode !== 'slip') d.ids.forEach((id) => { const c = S.clip(id); if (c) S.overwrite(c); });
      S.change(true);
    }
  };
  scroll.addEventListener('pointerup', endPointer);
  scroll.addEventListener('pointercancel', endPointer);

  const track_ = (c) => S.track(c.track) || {};
  tracksEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const clipEl = e.target.closest('.clip');
    if (clipEl) {
      const c = S.clip(clipEl.dataset.id);
      if (!S.sel.has(c.id)) S.setSelection([c.id]);
      const m = c.type === 'media' ? S.media(c.media) : null;
      popupMenu(e.clientX, e.clientY, [
        { label: 'Split at playhead', key: 'Ctrl+K', run: () => S.splitAtPlayhead() },
        '-',
        { label: 'Copy', key: 'Ctrl+C', run: () => S.copy() },
        { label: 'Paste at playhead', key: 'Ctrl+V', disabled: !S.clipboard, run: () => S.paste() },
        { label: 'Duplicate', key: 'Ctrl+D', run: () => S.duplicate() },
        '-',
        { label: 'Delete', key: 'Del', run: () => S.deleteClips(Array.from(S.sel), false) },
        { label: 'Ripple delete', key: 'Shift+Del', run: () => S.deleteClips(Array.from(S.sel), true) },
        '-',
        { label: 'Paste effects', key: 'Ctrl+Alt+V', disabled: !S.clipboard, run: () => { const n = S.pasteAttributes('effects'); if (n) toast('Effects pasted onto ' + n + ' clip' + (n > 1 ? 's' : '') + '.'); } },
        { label: 'Paste motion', disabled: !S.clipboard, run: () => { const n = S.pasteAttributes('motion'); if (n) toast('Motion pasted onto ' + n + ' clip' + (n > 1 ? 's' : '') + '.'); } },
        m && m.kind === 'video' && m.hasAudio && !c.mute && track_(c).type === 'video' ? { label: 'Detach audio', run: () => { if (!S.detachAudio()) toast('No free audio track.', 'err'); } } : null,
        m && m.hasAudio && m.kind !== 'image' ? { label: c.mute ? 'Unmute clip' : 'Mute clip', run: () => { S.checkpoint(); const to = !c.mute; S.selClips().forEach((x) => { x.mute = to; }); S.change(true); } } : null,
        '-',
        { label: 'Nest selected clips', run: () => Nest.nestSelected() },
        m && m.nest ? { label: 'Open nested sequence', run: () => S.enterNest(m.nest) } : null,
        m && !m.nest && m.kind !== 'image' ? { label: 'Speed ramp…', run: () => AI.speedRamp() } : null,
        m && !m.nest && m.kind === 'video' ? { label: 'Stabilize…', run: () => AI.stabilize() } : null,
        m && !m.nest && m.kind === 'video' ? { label: 'Track motion…', run: () => Tracker.open(c) } : null,
        m && !m.nest && (m.kind === 'video' || m.kind === 'image') ? { label: 'Remove background…', run: () => AI.removeBackground() } : null,
        c.bgr ? { label: 'Bring background back', run: () => AI.restoreBackground() } : null,
        { label: c.disabled ? 'Enable clip' : 'Disable clip', run: () => { S.checkpoint(); const to = !c.disabled; S.selClips().forEach((x) => { x.disabled = to; }); S.change(true); } },
        { label: 'Remove transition', disabled: !c.tr, run: () => { S.checkpoint(); c.tr = null; S.change(true); } },
        { label: 'Reset transform & effects', run: () => { S.checkpoint(); c.tf = Object.assign({}, DS.DEFAULT_TF); c.kf = DS.cleanKf(null); c.fx = DS.clone(DS.DEFAULT_FX); S.change(true); } },
        m ? '-' : null,
        m ? { label: 'Reveal media in folder', run: () => window.ditto.reveal(m.path) } : null
      ].filter(Boolean));
    } else {
      popupMenu(e.clientX, e.clientY, [
        { label: 'Paste at playhead', key: 'Ctrl+V', disabled: !S.clipboard, run: () => S.paste() },
        { label: 'Add marker', key: 'M', run: () => S.addMarker() }
      ]);
    }
  });

  // ---------------------------------------------------------------- drag & drop from bin / effects
  tracksEl.addEventListener('dblclick', (e) => {
    const ce = e.target.closest('.clip'); if (!ce) return;
    const c = S.clip(ce.dataset.id); const m = c && c.type === 'media' ? S.media(c.media) : null;
    if (m && m.nest) S.enterNest(m.nest);
  });
  tracksEl.addEventListener('dragover', (e) => {
    const types = Array.from(e.dataTransfer.types);
    if (!types.some((t) => t.startsWith('application/x-ditto'))) return;
    e.preventDefault();
    $$('.track.dropok').forEach((n) => n.classList.remove('dropok'));
    const tr = trackUnder(e.clientY);
    if (tr && trackEls[tr.id]) trackEls[tr.id].classList.add('dropok');
  });
  tracksEl.addEventListener('dragleave', (e) => { if (!tracksEl.contains(e.relatedTarget)) $$('.track.dropok').forEach((n) => n.classList.remove('dropok')); });
  tracksEl.addEventListener('drop', (e) => {
    $$('.track.dropok').forEach((n) => n.classList.remove('dropok'));
    const dt = e.dataTransfer;
    const tr = trackUnder(e.clientY);
    const t = S.snapTime(timeAt(e.clientX), new Set()).t;
    const mid = dt.getData('application/x-ditto-media');
    const trans = dt.getData('application/x-ditto-transition');
    const special = dt.getData('application/x-ditto-special');
    if (mid && tr) {
      e.preventDefault();
      const c = S.placeMedia(mid, tr.id, t);
      if (c) S.setSelection([c.id]);
    } else if (special) {
      e.preventDefault();
      S.placeSpecial(special, t);
    } else if (trans) {
      e.preventDefault();
      applyTransitionAt(trans, tr, timeAt(e.clientX));
    }
  });

  function applyTransitionAt(type, track, t) {
    if (!track || track.type !== 'video') { toast('Drop a transition on a video clip.', 'err'); return; }
    const list = S.trackClips(track.id);
    const hit = list.find((c) => t >= c.start && t <= DS.clipEnd(c));
    if (!hit) { toast('Drop the transition on a clip.', 'err'); return; }
    let target = hit;
    const nearEnd = (DS.clipEnd(hit) - t) < (t - hit.start);
    if (nearEnd) {
      const next = list.find((c) => Math.abs(c.start - DS.clipEnd(hit)) < 1.5 / S.project.fps);
      if (next) target = next;
    }
    S.checkpoint();
    target.tr = { type, dur: Math.min(1, target.dur) };
    S.setSelection([target.id]);
    S.change(true);
  }

  // ---------------------------------------------------------------- wheel / scroll
  scroll.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const px = e.clientX - scroll.getBoundingClientRect().left;
      setZoom(S.zoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18), (scroll.scrollLeft + px) / S.zoom, px);
    } else if (e.shiftKey) {
      e.preventDefault();
      scroll.scrollLeft += e.deltaY;
    }
  }, { passive: false });
  scroll.addEventListener('scroll', () => { heads.scrollTop = scroll.scrollTop; drawRuler(); });

  // ---------------------------------------------------------------- wiring
  S.on('change', () => render());
  S.on('select', () => render());
  S.on('load', () => { waveRequested.clear(); scroll.scrollLeft = 0; fit(); render(); });
  S.on('time', () => { placePlayhead(); followPlayhead(); });
  new ResizeObserver(() => { layout(); drawRuler(); }).observe(scroll);
  buildToolbar();

  return { render, fit, setZoom, zoomBy, setTool, syncToolbar, applyTransitionAt };
})();
