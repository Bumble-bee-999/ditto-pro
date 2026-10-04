'use strict';
/* Ditto Pro — application state, editing operations, undo/redo. */
const S = {
  project: DS.newProject(),
  filePath: null,
  dirty: false,
  sel: new Set(),
  selMedia: null,
  playhead: 0,
  playing: false,
  zoom: 80,
  tool: 'select',
  snap: true,
  clipboard: null,
  analysis: { ext: {}, fades: {} },
  rt: {}, // runtime info per media id: { peaks, perSec, proxyPct, proxyState }
  undoStack: [], redoStack: [], lastKey: null, lastKeyTime: 0,
  listeners: {}
};

S.on = (evt, fn) => { (S.listeners[evt] = S.listeners[evt] || []).push(fn); };
S.emit = (evt, arg) => { (S.listeners[evt] || []).forEach((fn) => { try { fn(arg); } catch (e) { console.error('listener error', evt, e); } }); };

// ---------------------------------------------------------------- lookups
S.media = (id) => S.project.media.find((m) => m.id === id);
S.clip = (id) => S.project.clips.find((c) => c.id === id);
S.track = (id) => S.project.tracks.find((t) => t.id === id);
S.selClips = () => S.project.clips.filter((c) => S.sel.has(c.id));
S.duration = () => DS.projectDuration(S.project);
S.frame = () => 1 / S.project.fps;
S.trackClips = (id) => DS.videoTrackClips(S.project, id);
S.rtFor = (id) => (S.rt[id] = S.rt[id] || {});

// ---------------------------------------------------------------- history
S.snapshot = () => JSON.stringify({
  tracks: S.project.tracks, clips: S.project.clips, markers: S.project.markers, workArea: S.project.workArea,
  width: S.project.width, height: S.project.height, fps: S.project.fps
});
S.restore = (snap) => {
  const o = JSON.parse(snap);
  Object.assign(S.project, o);
  S.project.clips.forEach(normalizeClip);
  for (const id of Array.from(S.sel)) if (!S.clip(id)) S.sel.delete(id);
};
S.checkpoint = (key) => {
  const now = Date.now();
  if (key && key === S.lastKey && now - S.lastKeyTime < 900) { S.lastKeyTime = now; return; }
  S.lastKey = key || null; S.lastKeyTime = now;
  S.undoStack.push(S.snapshot());
  if (S.undoStack.length > 200) S.undoStack.shift();
  S.redoStack.length = 0;
};
S.undo = () => {
  if (!S.undoStack.length) return;
  S.redoStack.push(S.snapshot());
  S.restore(S.undoStack.pop());
  S.lastKey = null;
  S.change(true);
};
S.redo = () => {
  if (!S.redoStack.length) return;
  S.undoStack.push(S.snapshot());
  S.restore(S.redoStack.pop());
  S.lastKey = null;
  S.change(true);
};
S.change = (structural) => {
  S.analysis = DS.analyze(S.project);
  S.dirty = true;
  S.emit('change', structural);
};
S.setSelection = (ids, additive) => {
  if (!additive) S.sel.clear();
  ids.forEach((id) => { if (additive && S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); });
  S.emit('select');
};

// ---------------------------------------------------------------- normalising loaded data
function normalizeClip(c) {
  c.tf = Object.assign({}, DS.DEFAULT_TF, c.tf);
  c.kf = DS.cleanKf(c.kf);
  const fx = DS.cleanFx(c.fx);   // every effect value coerced and clamped (also what keeps a hostile project file out of the filter script)
  fx.color = (c.fx && c.fx.color) ? DG.normalize(c.fx.color) : null;
  c.fx = fx;
  c.reverse = !!c.reverse;
  c.blend = DS.cleanBlend(c.blend);
  c.mute = !!c.mute;
  c.color = DS.cleanLabel(c.color);
  const ae = Object.assign({}, DS.clone(DS.DEFAULT_AE), c.ae);
  ae.comp = Object.assign({}, DS.DEFAULT_AE.comp, (c.ae || {}).comp);
  ae.echo = Object.assign({}, DS.DEFAULT_AE.echo, (c.ae || {}).echo);
  c.ae = ae;
  if (c.speed == null) c.speed = 1;
  if (c.vol == null) c.vol = 0;
  c.fadeIn = c.fadeIn || 0; c.fadeOut = c.fadeOut || 0;
  if (c.type === 'title') { const sh = Object.assign(DS.newTitle().shape, c.title && c.title.shape); c.title = Object.assign(DS.newTitle(), c.title); c.title.shape = sh; }
  return c;
}
S.normalizeClip = normalizeClip;

// ---------------------------------------------------------------- time
S.seek = (t, silent) => {
  S.playhead = Math.max(0, t);
  if (!silent) S.emit('time');
};
S.editPoints = () => {
  const s = new Set([0]);
  S.project.clips.forEach((c) => { s.add(round3(c.start)); s.add(round3(DS.clipEnd(c))); });
  return Array.from(s).sort((a, b) => a - b);
};
function round3(v) { return Math.round(v * 1000) / 1000; }
S.snapTime = (t, exclude) => {
  if (!S.snap) return { t, hit: null };
  const th = 9 / S.zoom;
  let best = null, bd = th;
  const test = (p) => { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } };
  test(0); test(S.playhead);
  S.project.markers.forEach((m) => test(m.t));
  if (S.project.workArea.in != null) test(S.project.workArea.in);
  if (S.project.workArea.out != null) test(S.project.workArea.out);
  S.project.clips.forEach((c) => { if (exclude && exclude.has(c.id)) return; test(c.start); test(DS.clipEnd(c)); });
  return best == null ? { t, hit: null } : { t: best, hit: best };
};

// ---------------------------------------------------------------- tracks
S.addTrack = (type) => {
  S.checkpoint();
  const list = S.project.tracks.filter((t) => t.type === type);
  let n = list.length + 1;
  while (S.track((type === 'video' ? 'V' : 'A') + n)) n++;
  const id = (type === 'video' ? 'V' : 'A') + n;
  const t = { id, type, name: id, mute: false, hidden: false, lock: false };
  // keep video tracks together before audio tracks, ordered by number
  if (type === 'video') {
    const idx = S.project.tracks.map((x) => x.type).lastIndexOf('video');
    S.project.tracks.splice(idx + 1, 0, t);
  } else S.project.tracks.push(t);
  S.change(true);
  return t;
};
S.removeTrack = (id) => {
  const t = S.track(id);
  if (!t) return;
  if (S.project.tracks.filter((x) => x.type === t.type).length <= 1) { toast('You need at least one ' + t.type + ' track.', 'err'); return; }
  S.checkpoint();
  S.project.clips = S.project.clips.filter((c) => c.track !== id);
  S.project.tracks = S.project.tracks.filter((x) => x.id !== id);
  for (const cid of Array.from(S.sel)) if (!S.clip(cid)) S.sel.delete(cid);
  S.change(true);
  S.emit('select');
};
S.toggleTrack = (id, prop) => {
  const t = S.track(id);
  if (!t) return;
  S.checkpoint();
  t[prop] = !t[prop];
  S.change(true);
};
S.trackFits = (track, media) => {
  if (!track) return false;
  if (media.kind === 'audio') return track.type === 'audio';
  return track.type === 'video';
};
S.freeTrackFor = (type, start, dur) => {
  const tracks = S.project.tracks.filter((t) => t.type === type && !t.lock);
  for (const t of tracks) {
    const busy = S.project.clips.some((c) => c.track === t.id && c.start < start + dur - 1e-6 && DS.clipEnd(c) > start + 1e-6);
    if (!busy) return t;
  }
  return null;
};

// ---------------------------------------------------------------- clip placement / overwrite
S.maxDur = (c) => {
  if (c.type !== 'media') return Infinity;
  const m = S.media(c.media);
  if (!m || m.kind === 'image') return Infinity;
  return Math.max(0.05, (m.duration - c.in) / (c.speed || 1));
};

function shiftKf(c, dt) {
  for (const p of DS.ALLPROPS) (c.kf[p] || []).forEach((k) => { k.t += dt; });
}

// Make room for `x` on its track: trims / splits / removes whatever it covers (like Premiere's overwrite).
S.overwrite = (x) => {
  const s = x.start, e = DS.clipEnd(x);
  const others = S.project.clips.filter((y) => y !== x && y.track === x.track);
  for (const y of others) {
    const ys = y.start, ye = DS.clipEnd(y);
    if (ye <= s + 1e-6 || ys >= e - 1e-6) continue;
    if (ys >= s - 1e-6 && ye <= e + 1e-6) { S.project.clips.splice(S.project.clips.indexOf(y), 1); S.sel.delete(y.id); }
    else if (ys < s && ye > e) {
      const right = DS.clone(y); right.id = DS.uid('clip');
      right.start = e; right.in = y.in + (e - ys) * y.speed; right.dur = ye - e; right.tr = null; right.fadeIn = 0;
      shiftKf(right, -(e - ys));
      y.dur = s - ys; y.fadeOut = 0;
      S.project.clips.push(right);
    } else if (ys < s) { y.dur = s - ys; }
    else { const d = e - ys; y.in += d * y.speed; y.start = e; y.dur -= d; shiftKf(y, -d); y.tr = null; }
  }
};

S.placeMedia = (mediaId, trackId, start, noCheckpoint) => {
  const m = S.media(mediaId);
  if (!m) return null;
  let track = S.track(trackId);
  if (!S.trackFits(track, m)) track = S.project.tracks.find((t) => S.trackFits(t, m) && !t.lock);
  if (!track) { toast('No unlocked ' + (m.kind === 'audio' ? 'audio' : 'video') + ' track available.', 'err'); return null; }
  if (track.lock) { toast('Track ' + track.name + ' is locked.', 'err'); return null; }
  if (!noCheckpoint) S.checkpoint();
  const c = DS.newClip({ track: track.id, media: m.id, start: Math.max(0, start), in: 0, dur: Math.max(0.1, m.duration), label: m.name });
  S.project.clips.push(c);
  S.overwrite(c);
  S.change(true);
  return c;
};
S.placeSpecial = (type, start) => {
  S.checkpoint();
  let tr;
  // graphics are title clips with no text and a shape: a colour matte (whole frame), a rectangle or an ellipse
  const GFX = { matte: 'Colour matte', rect: 'Rectangle', ellipse: 'Ellipse' };
  const shape = GFX[type] ? type : null;
  if (shape) type = 'title';
  const dur = type === 'title' ? 5 : Math.max(5, Math.min(30, S.duration() - start || 5));
  tr = S.freeTrackFor('video', start, dur) || S.project.tracks.filter((t) => t.type === 'video').pop();
  const c = DS.newClip({ track: tr.id, type, start, in: 0, dur, label: shape ? GFX[shape] : type === 'title' ? 'Title' : 'Adjustment Layer' });
  if (type === 'title') c.title = DS.newTitle();
  if (shape) { c.title.text = ''; c.title.shape.kind = shape; if (shape === 'matte') c.title.shape.color = '#202830'; }
  S.project.clips.push(c);
  S.overwrite(c);
  S.sel.clear(); S.sel.add(c.id);
  S.change(true); S.emit('select');
  return c;
};

S.split = (clipId, t) => {
  const a = S.clip(clipId);
  if (!a || t <= a.start + 0.01 || t >= DS.clipEnd(a) - 0.01) return null;
  const b = DS.clone(a); b.id = DS.uid('clip');
  const cut = t - a.start;
  b.start = t; b.in = a.in + cut * a.speed; b.dur = a.dur - cut; b.tr = null; b.fadeIn = 0;
  shiftKf(b, -cut);
  a.dur = cut; a.fadeOut = 0;
  S.project.clips.push(b);
  return b;
};
S.splitAtPlayhead = () => {
  const t = S.playhead;
  let targets = S.selClips().filter((c) => t > c.start && t < DS.clipEnd(c));
  if (!targets.length) targets = S.project.clips.filter((c) => t > c.start + 0.01 && t < DS.clipEnd(c) - 0.01 && !(S.track(c.track) || {}).lock);
  if (!targets.length) return;
  S.checkpoint();
  const added = [];
  targets.forEach((c) => { if (!(S.track(c.track) || {}).lock) { const b = S.split(c.id, t); if (b) added.push(b.id); } });
  S.change(true);
};

// ---------------------------------------------------------------- nested sequences
// A nest is a sub-timeline stored in project.nests. In the project it appears as a media item (m.nest) that the
// Nest module renders to a cache file; opening a nest swaps S.project for a view over the nest's tracks and clips.
S.nestStack = [];
S.rootProject = () => (S.nestStack.length ? S.nestStack[0].project : S.project);
S.nestMedia = (id) => S.rootProject().media.find((m) => m.nest === id);
S.commitNest = () => {
  const root = S.rootProject();
  for (let i = S.nestStack.length - 1; i >= 0; i--) {
    const view = i === S.nestStack.length - 1 ? S.project : S.nestStack[i + 1].project;
    const nest = root.nests[S.nestStack[i].childId];
    if (nest) { nest.clips = view.clips; nest.tracks = view.tracks; }
  }
};
S.nestSelection = () => {
  const p = S.project;
  const sel = S.selClips().filter((c) => !(S.track(c.track) || {}).lock);
  if (!sel.length) return null;
  S.checkpoint();
  const root = S.rootProject();
  const t0 = Math.min.apply(null, sel.map((c) => c.start)), t1 = Math.max.apply(null, sel.map((c) => DS.clipEnd(c)));
  const id = DS.uid('nest');
  const used = new Set(sel.map((c) => c.track));
  const name = 'Nested sequence ' + (Object.keys(root.nests).length + 1);
  root.nests[id] = { id, name, tracks: DS.clone(p.tracks.filter((t) => used.has(t.id))), clips: sel.map((c) => { const n = DS.clone(c); n.start -= t0; return n; }) };
  const m = { id: DS.uid('m'), kind: 'video', nest: id, name, path: '', duration: t1 - t0, hasAudio: true, w: p.width, h: p.height, fps: p.fps, thumb: null, url: null, previewUrl: null, needsProxy: false, missing: false };
  root.media.push(m);
  const hasVideo = sel.some((c) => S.track(c.track).type === 'video');
  const target = hasVideo ? p.tracks.find((t) => t.type === 'video' && used.has(t.id)) : S.track(sel[0].track);
  p.clips = p.clips.filter((c) => !sel.includes(c));
  const nc = DS.newClip({ track: target.id, media: m.id, start: t0, in: 0, dur: t1 - t0, label: name });
  p.clips.push(nc);
  S.overwrite(nc);
  S.sel.clear(); S.sel.add(nc.id);
  S.change(true); S.emit('media'); S.emit('select'); S.emit('nest', id);
  return id;
};
S.enterNest = (id) => {
  const root = S.rootProject();
  const nest = root.nests[id];
  if (!nest) return false;
  S.commitNest();
  const parent = S.project;
  const view = DS.newProject({ width: parent.width, height: parent.height, fps: parent.fps, name: nest.name });
  Object.assign(view, { media: root.media, tracks: nest.tracks, clips: nest.clips, markers: [], workArea: { in: null, out: null }, nests: root.nests });
  S.nestStack.push({ project: parent, childId: id });
  S.project = view;
  S.sel.clear(); S.undoStack = []; S.redoStack = []; S.lastKey = null; S.playhead = 0; S.playing = false;
  S.analysis = DS.analyze(view);
  S.emit('load'); S.emit('nestnav');
  return true;
};
S.exitNest = () => {
  if (!S.nestStack.length) return false;
  S.commitNest();
  const entry = S.nestStack.pop();
  const root = entry.project.nests ? entry.project : S.rootProject();
  const nest = root.nests[entry.childId] || S.rootProject().nests[entry.childId];
  S.project = entry.project;
  if (nest) { const m = S.nestMedia(nest.id); if (m) m.duration = Math.max(0.1, DS.projectDuration({ clips: nest.clips })); }
  S.sel.clear(); S.undoStack = []; S.redoStack = []; S.lastKey = null; S.playhead = 0; S.playing = false;
  S.analysis = DS.analyze(S.project);
  S.dirty = true;
  S.emit('load'); S.emit('nestnav'); S.emit('nest', entry.childId);
  return true;
};
S.exitAllNests = () => { while (S.nestStack.length) S.exitNest(); };

// ---------------------------------------------------------------- multicam
// Angles are ordinary clips on their own tracks that share c.mc = { group, angle }. Only the "live" angle is enabled.
S.multicamGroups = () => {
  const g = {};
  S.project.clips.forEach((c) => { if (c.mc) { (g[c.mc.group] = g[c.mc.group] || { id: c.mc.group, angles: new Set(), clips: [] }); g[c.mc.group].angles.add(c.mc.angle); g[c.mc.group].clips.push(c); } });
  return Object.values(g);
};
S.multicamCreate = (clips, lags) => {
  const list = clips.filter((c) => c.type === 'media');
  if (list.length < 2) return null;
  S.checkpoint();
  const group = DS.uid('mc');
  const base = list[0].start;
  const starts = list.map((c, i) => base - (lags[i] || 0));
  const shift = Math.min(0, Math.min.apply(null, starts));
  list.forEach((c, i) => {
    let n = 1; while (S.track('V' + n)) n++;
    const tr = { id: 'V' + n, type: 'video', name: 'Cam ' + (i + 1), mute: false, hidden: false, lock: false };
    const idx = S.project.tracks.map((x) => x.type).lastIndexOf('video');
    S.project.tracks.splice(idx + 1, 0, tr);
    c.track = tr.id; c.start = Math.max(0, starts[i] - shift); c.mc = { group, angle: i + 1 }; c.disabled = i !== 0;
  });
  S.sel.clear(); S.change(true); S.emit('select');
  return group;
};
// live angle at time t for a group (the enabled piece covering t)
S.multicamAngleAt = (group, t) => {
  const c = S.project.clips.find((x) => x.mc && x.mc.group === group && !x.disabled && t >= x.start - 1e-6 && t < DS.clipEnd(x) - 1e-6);
  return c ? c.mc.angle : 0;
};
// Cut to `angle` from t until the end of the current shot.
S.multicamSwitch = (group, angle, t) => {
  const all = () => S.project.clips.filter((x) => x.mc && x.mc.group === group);
  const cur = all().find((x) => !x.disabled && t >= x.start - 1e-6 && t < DS.clipEnd(x) - 1e-6);
  if (!cur) return { ok: false, reason: 'No shot at the playhead.' };
  if (cur.mc.angle === angle) return { ok: true, changed: false };
  const target = all().find((x) => x.mc.angle === angle && t >= x.start - 1e-6 && t < DS.clipEnd(x) - 1e-6);
  if (!target) return { ok: false, reason: 'Angle ' + angle + ' has no footage at this point.' };
  S.checkpoint();
  const b = Math.min(DS.clipEnd(cur), DS.clipEnd(target));
  const cutAt = (x, at) => { if (at > x.start + 0.01 && at < DS.clipEnd(x) - 0.01) S.split(x.id, at); };
  all().forEach((x) => { cutAt(x, t); });
  all().forEach((x) => { cutAt(x, b); });
  all().forEach((x) => {
    if (x.start >= t - 1e-6 && DS.clipEnd(x) <= b + 1e-6) x.disabled = x.mc.angle !== angle;
  });
  S.change(true);
  return { ok: true, changed: true };
};

// ---------------------------------------------------------------- captions (stored as title clips on their own track)
S.captionClips = () => S.project.clips.filter((c) => c.caption).sort((a, b) => a.start - b.start);
S.addCaptions = (cues) => {
  if (!cues.length) return 0;
  S.checkpoint();
  const p = S.project;
  let id = 1; while (S.track('V' + id)) id++;
  // captions sit on a new track above everything else
  let n = 1; while (S.track('V' + n)) n++;
  const tr = { id: 'V' + n, type: 'video', name: 'CC', mute: false, hidden: false, lock: false };
  const idx = p.tracks.map((x) => x.type).lastIndexOf('video');
  p.tracks.splice(idx + 1, 0, tr);
  for (const q of cues) {
    const c = DS.newClip({ track: tr.id, type: 'title', start: q.start, in: 0, dur: Math.max(0.2, q.end - q.start), label: q.text.slice(0, 40) });
    c.caption = true;
    if (q.words && q.words.length) c.words = q.words.map((w) => ({ s: Math.max(0, w.start - q.start), e: Math.max(0, w.end - q.start), w: w.text }));
    c.title = Object.assign(DS.newTitle(q.text), { size: Math.round(p.height * 0.05), bold: true, shadow: false, stroke: '#000000', strokeW: Math.max(2, Math.round(p.height / 270)), bg: true, bgAlpha: 45 });
    c.tf.y = Math.round(p.height * 0.36);
    p.clips.push(c);
  }
  S.change(true); S.emit('select');
  return cues.length;
};
S.removeCaptions = () => {
  const caps = S.captionClips();
  if (!caps.length) return 0;
  S.checkpoint();
  const tracks = new Set(caps.map((c) => c.track));
  S.project.clips = S.project.clips.filter((c) => !c.caption);
  // drop caption tracks that are now empty
  S.project.tracks = S.project.tracks.filter((t) => !(tracks.has(t.id) && t.name === 'CC' && !S.project.clips.some((c) => c.track === t.id)));
  S.sel.clear(); S.change(true); S.emit('select');
  return caps.length;
};

// Replace each clip by the parts that survive removing `silences` (source seconds), closing the gaps on its track.
S.applySilenceCuts = (plan) => {
  const list = plan.map((p) => ({ c: S.clip(p.id), sil: p.silences })).filter((x) => x.c && !(S.track(x.c.track) || {}).lock).sort((a, b) => b.c.start - a.c.start);
  if (!list.length) return 0;
  S.checkpoint();
  let removedTotal = 0;
  for (const { c, sil } of list) {
    const segs = DS.keepSegments(c, sil), sp = c.speed || 1, end = DS.clipEnd(c);
    const news = []; let cursor = c.start;
    segs.forEach((g, i) => {
      const n = DS.clone(c); n.id = DS.uid('clip');
      n.in = g.in; n.dur = g.dur / sp; n.start = cursor;
      if (i > 0) { n.tr = null; n.fadeIn = 0; }
      if (i < segs.length - 1) n.fadeOut = 0;
      shiftKf(n, -(g.in - c.in) / sp);
      news.push(n); cursor += n.dur;
    });
    const removed = c.dur - (cursor - c.start);
    removedTotal += removed;
    S.project.clips = S.project.clips.filter((x) => x !== c);
    S.project.clips.forEach((o) => { if (o.track === c.track && o.start >= end - 1e-6) o.start = Math.max(0, o.start - removed); });
    news.forEach((n) => S.project.clips.push(n));
  }
  S.sel.clear(); S.change(true); S.emit('select');
  return removedTotal;
};
// Split a clip at the given source times (e.g. detected scene changes)
S.splitAtSourceTimes = (clipId, times) => {
  const c0 = S.clip(clipId);
  if (!c0 || (S.track(c0.track) || {}).lock) return 0;
  const sp = c0.speed || 1;
  const cuts = times.map((t) => c0.start + (t - c0.in) / sp).filter((tl) => tl > c0.start + 0.05 && tl < DS.clipEnd(c0) - 0.05).sort((a, b) => a - b);
  if (!cuts.length) return 0;
  S.checkpoint();
  let n = 0;
  for (const tl of cuts) {
    const target = S.project.clips.find((x) => x.track === c0.track && x.media === c0.media && tl > x.start + 0.01 && tl < DS.clipEnd(x) - 0.01);
    if (target && S.split(target.id, tl)) n++;
  }
  S.change(true);
  return n;
};

// ---------------------------------------------------------------- speed ramps
// Replaces a clip by a chain of short constant-speed pieces following a speed curve (see DS.rampSegments).
S.speedRamp = (clipId, o) => {
  const c = S.clip(clipId);
  if (!c || c.type !== 'media' || (S.track(c.track) || {}).lock) return null;
  const m = S.media(c.media);
  if (!m || m.kind === 'image') return null;
  const orig = c.ramp ? c.ramp.orig : { speed: c.speed };
  const L = c.dur * c.speed;
  const segs = DS.rampSegments({ srcIn: c.in, srcLen: L, fps: S.project.fps, from: o.from, to: o.to, curve: o.curve, steps: o.steps });
  const total = segs.reduce((a, x) => a + x.dur, 0);
  S.checkpoint();
  const g = DS.uid('ramp');
  // keyframes follow the picture: old clip time -> source time -> new clip time
  const mapT = (t) => {
    const so = t * c.speed;
    for (const sg of segs) if (so <= (sg.in - c.in) + sg.span + 1e-9) return sg.start + Math.max(0, so - (sg.in - c.in)) / sg.speed;
    return total;
  };
  const news = segs.map((sg, i) => {
    const n = DS.clone(c); n.id = DS.uid('clip');
    n.in = sg.in; n.speed = sg.speed; n.dur = sg.dur; n.start = c.start + sg.start;
    n.ramp = { g, i, n: segs.length, orig: { speed: orig.speed } };
    if (i > 0) { n.tr = null; n.fadeIn = 0; }
    if (i < segs.length - 1) n.fadeOut = 0;
    DS.ALLPROPS.forEach((p) => {
      const list = c.kf[p];
      if (!list || !list.length) return;
      const mapped = list.map((k) => ({ t: mapT(k.t), v: k.v, e: k.e }));
      const lo = sg.start, hi = sg.start + sg.dur;
      const out = [{ t: 0, v: DS.kfEval(mapped, lo, DS.baseOf(c, p)), e: 'lin' }];
      mapped.forEach((k) => { if (k.t > lo + 1e-6 && k.t < hi - 1e-6) out.push({ t: k.t - lo, v: k.v, e: k.e }); });
      out.push({ t: sg.dur, v: DS.kfEval(mapped, hi, DS.baseOf(c, p)), e: 'lin' });
      n.kf[p] = out;
    });
    return n;
  });
  const end = DS.clipEnd(c), delta = total - c.dur;
  S.project.clips = S.project.clips.filter((x) => x !== c);
  if (o.ripple !== false) S.project.clips.forEach((x) => { if (x.track === c.track && x.start >= end - 1e-6) x.start = Math.max(0, x.start + delta); });
  news.forEach((n) => S.project.clips.push(n));
  S.sel.clear(); news.forEach((n) => S.sel.add(n.id));
  S.change(true); S.emit('select');
  return { group: g, pieces: news.length, delta };
};
// Joins the pieces of a ramp back into one clip at constant speed.
S.speedRampRestore = (group) => {
  const list = S.project.clips.filter((c) => c.ramp && c.ramp.g === group).sort((a, b) => a.start - b.start);
  if (!list.length) return false;
  S.checkpoint();
  const first = list[0], last = list[list.length - 1];
  const srcSpan = list.reduce((a, c) => a + c.dur * c.speed, 0);
  const sp = first.ramp.orig.speed || 1;
  const merged = DS.clone(first); merged.id = DS.uid('clip'); delete merged.ramp;
  merged.speed = sp; merged.dur = srcSpan / sp; merged.fadeOut = last.fadeOut;
  merged.kf = DS.cleanKf(null);
  const end = DS.clipEnd(last), delta = merged.dur - (end - first.start);
  S.project.clips = S.project.clips.filter((c) => !list.includes(c));
  S.project.clips.forEach((x) => { if (x.track === first.track && x.start >= end - 1e-6) x.start = Math.max(0, x.start + delta); });
  S.project.clips.push(merged);
  S.sel.clear(); S.sel.add(merged.id);
  S.change(true); S.emit('select');
  return true;
};

// ---------------------------------------------------------------- remove a time range from every track (ripple)
// Used by the transcript editor: deleting words cuts that moment out of the picture and sound together.
S.extractRange = (t0, t1, opts) => {
  if (!(t1 > t0 + 1e-3)) return 0;
  const p = S.project, len = t1 - t0;
  if (!(opts && opts.noCheckpoint)) S.checkpoint();
  // captions: keep the words that survive, rebuild the line around them
  const rebuild = [];
  for (const c of p.clips.filter((x) => x.caption && x.words && x.words.length)) {
    const cs = c.start, ce = DS.clipEnd(c);
    if (ce <= t0 + 1e-6 || cs >= t1 - 1e-6) continue;
    const keep = c.words.map((w) => ({ s: cs + w.s, e: cs + w.e, w: w.w })).filter((w) => { const mid = (w.s + w.e) / 2; return mid < t0 || mid >= t1; });
    rebuild.push({ c, keep });
  }
  rebuild.forEach(({ c }) => { p.clips.splice(p.clips.indexOf(c), 1); S.sel.delete(c.id); });
  // everything else: split at both ends, drop the middle, close the gap
  const unlocked = (c) => !(S.track(c.track) || {}).lock;
  [t1, t0].forEach((at) => { p.clips.filter((c) => unlocked(c) && at > c.start + 1e-3 && at < DS.clipEnd(c) - 1e-3).forEach((c) => S.split(c.id, at)); });
  p.clips = p.clips.filter((c) => !(unlocked(c) && c.start >= t0 - 1e-6 && DS.clipEnd(c) <= t1 + 1e-6));
  p.clips.forEach((c) => { if (unlocked(c) && c.start >= t1 - 1e-6) c.start = Math.max(0, c.start - len); });
  p.markers.forEach((m) => { if (m.t >= t1) m.t -= len; else if (m.t > t0) m.t = t0; });
  // rebuilt captions
  rebuild.forEach(({ c, keep }) => {
    if (!keep.length) return;
    const sh = (v) => (v >= t1 - 1e-6 ? v - len : v);
    const ws = keep.map((w) => ({ s: sh(w.s), e: sh(w.e), w: w.w }));
    const n = DS.clone(c); n.id = DS.uid('clip');
    n.start = ws[0].s; n.dur = Math.max(0.2, ws[ws.length - 1].e - ws[0].s);
    n.words = ws.map((w) => ({ s: w.s - n.start, e: w.e - n.start, w: w.w }));
    n.title.text = ws.map((w) => w.w).join(' ');
    n.label = n.title.text.slice(0, 40);
    p.clips.push(n);
  });
  if (S.playhead > t0) S.playhead = Math.max(t0, S.playhead - len);
  S.change(true); S.emit('select');
  return len;
};

// lift: remove what lies between t0 and t1 on every unlocked track and leave the gap
S.liftRange = (t0, t1) => {
  const p = S.project;
  if (!(t1 > t0 + 1e-3)) return 0;
  S.checkpoint();
  const unlocked = (c) => !(S.track(c.track) || {}).lock;
  [t1, t0].forEach((at) => { p.clips.filter((c) => unlocked(c) && at > c.start + 1e-3 && at < DS.clipEnd(c) - 1e-3).forEach((c) => S.split(c.id, at)); });
  const gone = p.clips.filter((c) => unlocked(c) && c.start >= t0 - 1e-6 && DS.clipEnd(c) <= t1 + 1e-6);
  p.clips = p.clips.filter((c) => !gone.includes(c));
  gone.forEach((c) => S.sel.delete(c.id));
  S.change(true); S.emit('select');
  return gone.length;
};

// freeze frame ("frame hold"): splits the clip at the playhead and inserts a still of that picture, rippling the track
S.freezeFrame = (clipId, stillMedia, dur) => {
  const c = S.clip(clipId), t = S.playhead;
  if (!c || c.type !== 'media' || !stillMedia) return null;
  if (t <= c.start + 0.01 || t >= DS.clipEnd(c) - 0.01) return null;
  const tr = S.track(c.track);
  if (!tr || tr.lock) return null;
  S.checkpoint();
  const b = S.split(c.id, t);
  if (!b) return null;
  const p = S.project;
  p.clips.forEach((x) => { if (x.track === c.track && x !== c && x.start >= t - 1e-6) x.start += dur; });
  const still = DS.clone(c);
  still.id = DS.uid('clip'); still.media = stillMedia.id; still.start = t; still.in = 0; still.dur = dur; still.speed = 1; still.reverse = false;
  still.fadeIn = 0; still.fadeOut = 0; still.tr = null; still.vol = 0; still.label = 'Freeze frame'; still.ramp = null; delete still.ramp;
  DS.ALLPROPS.forEach((k) => { still.kf[k] = []; });
  p.clips.push(still);
  S.setSelection([still.id]);
  S.change(true);
  return still;
};

// ---------------------------------------------------------------- ripple / slip / nudge / attributes
const _unlocked = (c) => !(S.track(c.track) || {}).lock;
// opens `len` seconds of room at t on every unlocked track (clips crossing t are split)
S.insertGap = (t, len, noCheckpoint) => {
  const p = S.project;
  if (!(len > 1e-3)) return;
  if (!noCheckpoint) S.checkpoint();
  p.clips.filter((c) => _unlocked(c) && t > c.start + 1e-3 && t < DS.clipEnd(c) - 1e-3).forEach((c) => S.split(c.id, t));
  p.clips.forEach((c) => { if (_unlocked(c) && c.start >= t - 1e-6) c.start += len; });
  p.markers.forEach((m) => { if (m.t >= t) m.t += len; });
};
// insert edit: everything after the playhead moves right and the media goes into the room that opens
S.insertMedia = (mediaId) => {
  const m = S.media(mediaId);
  if (!m) return null;
  const type = m.kind === 'audio' ? 'audio' : 'video';
  const tr = S.project.tracks.find((t) => t.type === type && !t.lock);
  if (!tr) { toast('No unlocked ' + type + ' track available.', 'err'); return null; }
  S.checkpoint();
  const t = S.playhead, dur = Math.max(0.1, m.duration);
  S.insertGap(t, dur, true);
  const c = DS.newClip({ track: tr.id, media: m.id, start: t, in: 0, dur, label: m.name });
  S.project.clips.push(c);
  S.setSelection([c.id]);
  S.change(true);
  return c;
};
// "ripple trim to playhead": removes from the previous cut to the playhead ('prev') or from the playhead to the next cut ('next')
S.rippleTrimToPlayhead = (side) => {
  const t = S.playhead;
  const under = S.project.clips.filter((c) => _unlocked(c) && !c.caption && c.start < t - 1e-3 && DS.clipEnd(c) > t + 1e-3);
  if (!under.length) return 0;
  if (side === 'prev') return S.extractRange(Math.max.apply(null, under.map((c) => c.start)), t);
  return S.extractRange(t, Math.min.apply(null, under.map((c) => DS.clipEnd(c))));
};
// moves the selected clips by whole frames
S.nudge = (frames) => {
  const list = S.selClips().filter(_unlocked);
  if (!list.length) return 0;
  let d = frames * S.frame();
  d = Math.max(d, -Math.min.apply(null, list.map((c) => c.start)));
  if (Math.abs(d) < 1e-6) return 0;
  S.checkpoint('nudge');
  list.forEach((c) => { c.start = Math.round((c.start + d) * 1e4) / 1e4; });
  list.forEach((c) => S.overwrite(c));
  S.change(true);
  return d;
};
// slip: the clip stays where it is, the part of the source it shows moves
S.slipBy = (c, seconds) => {
  const m = c.type === 'media' ? S.media(c.media) : null;
  if (!m || m.kind === 'image' || c.ramp) return 0;
  const max = Math.max(0, m.duration - c.dur * (c.speed || 1));
  const ni = DS.clamp(c.in + seconds * (c.speed || 1), 0, max);
  const d = ni - c.in; c.in = ni;
  return d;
};
S.slip = (frames) => {
  const list = S.selClips().filter(_unlocked);
  if (!list.length) return 0;
  S.checkpoint('slip');
  let moved = 0;
  list.forEach((c) => { if (Math.abs(S.slipBy(c, frames * S.frame())) > 1e-9) moved++; });
  S.change(true);
  return moved;
};
// paste attributes: 'effects' = colour / effects / blend / audio, 'motion' = position, scale, rotation, opacity
S.pasteAttributes = (what) => {
  const src = S.clipboard && S.clipboard[0];
  const list = S.selClips().filter(_unlocked);
  if (!src || !list.length) return 0;
  S.checkpoint();
  const kfTo = (c, props) => props.forEach((p) => { c.kf[p] = DS.clone((src.kf && src.kf[p]) || []).filter((k) => k.t <= c.dur + 1e-6); });
  list.forEach((c) => {
    if (what === 'motion') {
      if (c.type === 'adjust') return;
      c.tf = Object.assign({}, DS.DEFAULT_TF, src.tf); kfTo(c, DS.PROPS);
    } else {
      if (src.fx && c.type !== 'title') { c.fx = DS.clone(src.fx); kfTo(c, DS.FXPROPS); }
      c.blend = DS.cleanBlend(src.blend);
      if (src.ae) c.ae = DS.clone(src.ae);
      c.vol = src.vol || 0; kfTo(c, DS.AUDIOPROPS);
    }
    normalizeClip(c);
  });
  S.change(true);
  return list.length;
};
// closes the gaps between clips on the given tracks (all unlocked tracks when none are given); the first clip stays put
S.closeGaps = (trackIds) => {
  const tracks = S.project.tracks.filter((t) => !t.lock && (!trackIds || trackIds.includes(t.id)));
  let closed = 0;
  const moves = [];
  tracks.forEach((t) => {
    const list = S.project.clips.filter((c) => c.track === t.id).sort((a, b) => a.start - b.start);
    let pos = null;
    list.forEach((c) => { if (pos != null && c.start > pos + 1e-4) { moves.push([c, pos]); closed++; pos += c.dur; } else pos = Math.max(pos == null ? 0 : pos, DS.clipEnd(c)); });
  });
  if (!closed) return 0;
  S.checkpoint();
  moves.forEach(([c, to]) => { c.start = to; });
  S.change(true);
  return closed;
};
// detach audio: the clip's sound becomes its own clip on an audio track, the picture clip goes silent
S.detachAudio = () => {
  const list = S.selClips().filter((c) => { if (!_unlocked(c) || c.type !== 'media' || c.mute || (S.track(c.track) || {}).type !== 'video') return false; const m = S.media(c.media); return m && m.hasAudio && m.kind === 'video'; });
  if (!list.length) return 0;
  S.checkpoint();
  list.forEach((c) => {
    const tr = S.freeTrackFor('audio', c.start, c.dur) || S.project.tracks.find((t) => t.type === 'audio' && !t.lock);
    if (!tr) return;
    const a = DS.newClip({ track: tr.id, media: c.media, start: c.start, in: c.in, dur: c.dur, speed: c.speed, reverse: c.reverse, vol: c.vol, fadeIn: c.fadeIn, fadeOut: c.fadeOut, label: c.label });
    a.ae = DS.clone(c.ae); a.kf.vol = DS.clone(c.kf.vol || []);
    c.mute = true;
    S.project.clips.push(a); S.overwrite(a);
  });
  S.change(true);
  return list.length;
};

// several ranges at once (one undo step); they are removed back to front so earlier times stay valid
S.extractRanges = (ranges) => {
  const list = ranges.filter((r) => r.t1 > r.t0 + 1e-3).sort((a, b) => b.t0 - a.t0);
  if (!list.length) return 0;
  S.checkpoint();
  let total = 0;
  list.forEach((r) => { total += S.extractRange(r.t0, r.t1, { noCheckpoint: true }); });
  return total;
};

S.deleteClips = (ids, ripple) => {
  const list = ids.map(S.clip).filter((c) => c && !(S.track(c.track) || {}).lock);
  if (!list.length) return;
  S.checkpoint();
  if (ripple) {
    list.sort((a, b) => b.start - a.start);
    for (const c of list) {
      const end = DS.clipEnd(c);
      S.project.clips.forEach((o) => { if (o !== c && o.track === c.track && o.start >= end - 1e-6) o.start = Math.max(0, o.start - c.dur); });
    }
  }
  const dead = new Set(list.map((c) => c.id));
  S.project.clips = S.project.clips.filter((c) => !dead.has(c.id));
  dead.forEach((id) => S.sel.delete(id));
  S.change(true); S.emit('select');
};

S.copy = () => {
  const list = S.selClips();
  if (!list.length) return;
  const t0 = Math.min.apply(null, list.map((c) => c.start));
  S.clipboard = list.map((c) => { const o = DS.clone(c); o._off = c.start - t0; return o; });
  toast(list.length + ' clip' + (list.length > 1 ? 's' : '') + ' copied', null, 1200);
};
S.paste = () => {
  if (!S.clipboard || !S.clipboard.length) return;
  S.checkpoint();
  const ids = [];
  S.clipboard.forEach((o) => {
    const c = DS.clone(o); delete c._off;
    c.id = DS.uid('clip'); c.start = S.playhead + o._off; c.tr = null;
    if (!S.track(c.track)) return;
    S.project.clips.push(c); S.overwrite(c); ids.push(c.id);
  });
  S.sel.clear(); ids.forEach((id) => S.sel.add(id));
  S.change(true); S.emit('select');
};
S.duplicate = () => {
  const list = S.selClips();
  if (!list.length) return;
  S.checkpoint();
  const end = Math.max.apply(null, list.map((c) => DS.clipEnd(c)));
  const t0 = Math.min.apply(null, list.map((c) => c.start));
  const ids = [];
  list.forEach((o) => {
    const c = DS.clone(o); c.id = DS.uid('clip'); c.start = end + (o.start - t0); c.tr = null;
    S.project.clips.push(c); S.overwrite(c); ids.push(c.id);
  });
  S.sel.clear(); ids.forEach((id) => S.sel.add(id));
  S.change(true); S.emit('select');
};

// ---------------------------------------------------------------- property edits
S.setSpeed = (c, speed) => {
  speed = DS.clamp(speed, 0.1, 8);
  const src = c.dur * c.speed;
  const k = c.speed / speed;
  DS.ALLPROPS.forEach((p) => (c.kf[p] || []).forEach((kf) => { kf.t *= k; }));
  c.speed = speed;
  c.dur = Math.max(0.05, src / speed);
  S.overwrite(c);
};

// set a transform property honouring keyframes (auto-key at the playhead when the property is animated)
S.setTf = (c, prop, value) => {
  const list = c.kf[prop];
  if (list && list.length) {
    const lt = DS.clamp(S.playhead - c.start, 0, c.dur);
    DS.addKeyframe(c, prop, lt, value, 'lin');
  } else DS.setBase(c, prop, value);
};
S.toggleKeyframe = (c, prop) => {
  const lt = DS.clamp(S.playhead - c.start, 0, c.dur);
  const list = c.kf[prop] = c.kf[prop] || [];
  const hit = list.findIndex((k) => Math.abs(k.t - lt) < S.frame() * 0.6);
  S.checkpoint();
  if (hit >= 0) {
    list.splice(hit, 1);
    if (list.length === 1) DS.setBase(c, prop, list[0].v); // keep value when only one remains
    if (list.length === 0) { /* base value stays as the last evaluated value */ }
  } else {
    const cur = DS.kfEval(list, lt, DS.baseOf(c, prop));
    DS.addKeyframe(c, prop, lt, cur, 'lin');
  }
  S.change();
};
S.clearKeyframes = (c, prop) => {
  const cur = DS.kfEval(c.kf[prop], DS.clamp(S.playhead - c.start, 0, c.dur), DS.baseOf(c, prop));
  S.checkpoint();
  c.kf[prop] = []; DS.setBase(c, prop, cur);
  S.change();
};
S.kfNav = (c, prop, dir) => {
  const list = c.kf[prop] || [];
  const lt = S.playhead - c.start;
  const eps = S.frame() * 0.5;
  const cand = dir > 0 ? list.filter((k) => k.t > lt + eps) : list.filter((k) => k.t < lt - eps).reverse();
  if (cand.length) S.seek(c.start + cand[0].t);
};

// ---------------------------------------------------------------- markers & work area
S.addMarker = () => {
  S.checkpoint();
  const m = DR.newMarker(S.playhead, S.author(), Date.now());
  S.project.markers.push(m);
  S.project.markers.sort((a, b) => a.t - b.t);
  S.change();
  return m;
};
// the name comments are signed with (kept on this computer, never in the project)
S.author = () => { try { return localStorage.getItem('ditto.author') || S.defaultAuthor || 'Me'; } catch (e) { return S.defaultAuthor || 'Me'; } };
S.setAuthor = (n) => { try { localStorage.setItem('ditto.author', DR.cleanText(n, DR.LIM.author)); } catch (e) { /* storage unavailable */ } };
S.markerById = (id) => S.project.markers.find((m) => m.id === id);
S.addComment = (markerId, text) => {
  const m = S.markerById(markerId); if (!m || !DR.cleanText(text, 10)) return null;
  S.checkpoint(); const c = DR.addComment(m, S.author(), text, Date.now()); S.change(); return c;
};
S.resolveMarker = (markerId, flag) => { const m = S.markerById(markerId); if (!m) return; S.checkpoint(); DR.setResolved(m, flag, Date.now()); S.change(); };
S.renameMarker = (markerId, name) => { const m = S.markerById(markerId); if (!m) return; S.checkpoint(); m.name = DR.cleanText(name, DR.LIM.name); m.updated = Date.now(); S.change(); };
S.removeMarker = (id) => {
  S.checkpoint();
  S.project.markers = S.project.markers.filter((m) => m.id !== id);
  S.change();
};
S.setWorkIn = () => { S.checkpoint(); S.project.workArea.in = S.playhead; if (S.project.workArea.out != null && S.project.workArea.out <= S.playhead) S.project.workArea.out = null; S.change(); };
S.setWorkOut = () => { S.checkpoint(); S.project.workArea.out = S.playhead; if (S.project.workArea.in != null && S.project.workArea.in >= S.playhead) S.project.workArea.in = null; S.change(); };
S.clearWork = () => { S.checkpoint(); S.project.workArea = { in: null, out: null }; S.change(); };

// ---------------------------------------------------------------- media
S.addMediaItems = (items) => {
  const known = new Set(S.project.media.map((m) => m.path.toLowerCase()));
  const added = [];
  items.forEach((m) => {
    if (known.has(m.path.toLowerCase())) return;
    S.project.media.push(m); added.push(m);
    S.rtFor(m.id);
  });
  if (added.length) { S.dirty = true; S.emit('media'); }
  return added;
};
S.removeMedia = (id) => {
  const used = S.project.clips.filter((c) => c.media === id);
  S.checkpoint();
  S.project.clips = S.project.clips.filter((c) => c.media !== id);
  used.forEach((c) => S.sel.delete(c.id));
  S.project.media = S.project.media.filter((m) => m.id !== id);
  delete S.rt[id];
  S.change(true); S.emit('media'); S.emit('select');
};

// ---------------------------------------------------------------- project (de)serialisation
S.serialize = () => {
  S.commitNest();
  const p = S.rootProject();
  return JSON.stringify({
    app: 'ditto-pro', v: 1, id: p.id, audioLayout: p.audioLayout === '5.1' ? '5.1' : 'stereo', name: p.name, width: p.width, height: p.height, fps: p.fps,
    media: p.media.map((m) => ({ id: m.id, path: m.nest ? '' : m.path, name: m.name, kind: m.kind, duration: m.duration, w: m.w, h: m.h, fps: m.fps, hasAudio: m.hasAudio, vcodec: m.vcodec, acodec: m.acodec, nest: m.nest || undefined })),
    tracks: p.tracks, clips: p.clips, markers: p.markers, workArea: p.workArea, nests: p.nests || {}
  }, null, 1);
};
S.load = (obj, filePath) => {
  const p = DS.newProject();
  Object.assign(p, {
    id: DR.cleanId(obj.id) || p.id,
    name: obj.name || 'Untitled', width: obj.width || p.width, height: obj.height || p.height, fps: obj.fps || p.fps,
    media: (obj.media || []).map((m) => Object.assign({ thumb: null, url: null, previewUrl: null, needsProxy: false, missing: false }, m)),
    tracks: obj.tracks && obj.tracks.length ? obj.tracks : p.tracks,
    clips: (obj.clips || []).map(normalizeClip),
    markers: (obj.markers || []).map(DR.normMarker).filter(Boolean), workArea: obj.workArea || { in: null, out: null },
    nests: obj.nests || {}, audioLayout: obj.audioLayout === '5.1' ? '5.1' : 'stereo'
  });
  Object.values(p.nests).forEach((n) => { n.clips = (n.clips || []).map(normalizeClip); });
  S.nestStack = [];
  S.project = p; S.filePath = filePath || null;
  S.sel.clear(); S.undoStack = []; S.redoStack = []; S.lastKey = null;
  S.rt = {}; S.playhead = 0; S.playing = false;
  S.analysis = DS.analyze(p);
  S.dirty = false;
  S.mediaChecked = false;   // the files have not been looked for yet (App.reconnectMedia does that, then nests are rendered)
  S.emit('load');
};
S.newProject = (opts) => {
  S.nestStack = [];
  S.project = DS.newProject(opts);
  S.filePath = null; S.sel.clear(); S.undoStack = []; S.redoStack = []; S.rt = {}; S.playhead = 0; S.playing = false;
  S.analysis = DS.analyze(S.project);
  S.dirty = false;
  S.mediaChecked = true;
  S.emit('load');
};
