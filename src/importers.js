'use strict';
/*
 * Ditto Pro — project importers: CMX3600 EDL, Final Cut Pro XML (xmeml, which Premiere Pro can export),
 * FCPXML 1.x and (experimental, best effort) Premiere Pro .prproj files.
 * Pure Node, no Electron. Every importer produces a Ditto project object (same shape as a .dpro file).
 * Imported clips keep their timing and source ranges; effects and transitions other than simple dissolves are not carried over.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { XMLParser } = require('fast-xml-parser');
const DS = require('./shared');

const AUDIO_EXT = ['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.opus', '.wma', '.aif', '.aiff'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'];
const TICKS_PER_SECOND = 254016000000; // Premiere's internal time base

const A = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = (n) => (n == null ? '' : typeof n === 'object' ? (n['#text'] == null ? '' : String(n['#text'])) : String(n));
const numOf = (n, d) => { const v = parseFloat(txt(n)); return isFinite(v) ? v : (d == null ? 0 : d); };

// ------------------------------------------------------------------------------------------------ timecode
function tcToSeconds(tc, fps) {
  const m = String(tc).trim().match(/^(\d+):(\d\d):(\d\d)([:;])(\d\d+)$/);
  if (!m) return null;
  const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[5], drop = m[4] === ';';
  const nominal = Math.round(fps);
  let frames = ((hh * 60 + mm) * 60 + ss) * nominal + ff;
  if (drop && nominal > 0) {
    const dropPer = Math.round(nominal / 15); // 2 for 30, 4 for 60
    const totalMin = hh * 60 + mm;
    frames -= dropPer * (totalMin - Math.floor(totalMin / 10));
  }
  return frames / fps;
}

function fileUrlToPath(u) {
  if (!u) return '';
  let s = String(u).trim();
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:\/\/localhost/i, '').replace(/^file:\/\//i, '');
    try { s = decodeURIComponent(s); } catch (e) { /* keep as is */ }
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  }
  return s;
}

// ------------------------------------------------------------------------------------------------ model → project
/**
 * model: { name, width, height, fps, clips: [{ kind:'video'|'audio', lane (>=1), file, name, start, in, dur, speed, dissolve }] }
 * file may be a bare name when the source path is unknown (the media then simply shows as offline and can be relinked).
 */
function buildProject(model, warnings) {
  warnings = warnings || [];
  const fps = model.fps > 0 ? model.fps : 30;
  const p = DS.newProject({ width: model.width || 1920, height: model.height || 1080, fps, name: model.name || 'Imported project' });
  const mediaByKey = new Map();
  const clips = model.clips.filter((c) => c.dur > 0.001 && isFinite(c.start) && c.start >= -0.001);

  // an audio clip that exactly mirrors a video clip is that clip's own sound (Ditto video clips carry their audio)
  const base = (f) => path.basename(String(f || '').replace(/\\/g, '/')).toLowerCase();
  const tkey = (c) => [base(c.file || c.name), c.start.toFixed(3), c.in.toFixed(3), c.dur.toFixed(3)].join('|');
  const vkeys = new Set(clips.filter((c) => c.kind === 'video').map(tkey));
  const seenAudio = new Set();
  const kept = [];
  for (const c of clips) {
    const key = tkey(c);
    if (c.kind === 'audio') {
      if (vkeys.has(key) && !AUDIO_EXT.includes(path.extname(c.file || '').toLowerCase())) continue;
      if (seenAudio.has(key)) continue; // stereo pairs arrive as two mono tracks
      seenAudio.add(key);
    }
    kept.push(c);
  }

  let maxV = 3, maxA = 3;
  for (const c of kept) {
    const ext = path.extname(c.file || '').toLowerCase();
    const kind = AUDIO_EXT.includes(ext) ? 'audio' : IMAGE_EXT.includes(ext) ? 'image' : 'video';
    const key = base(c.file || c.name) || 'unknown';
    let m = mediaByKey.get(key);
    if (!m) {
      m = { id: DS.uid('m'), path: c.file || '', name: path.basename(String(c.file || c.name || 'media').replace(/\\/g, '/')) || 'media', kind, duration: 0, hasAudio: kind !== 'image', w: kind === 'video' ? p.width : undefined, h: kind === 'video' ? p.height : undefined, fps: kind === 'video' ? fps : undefined, missing: true };
      mediaByKey.set(key, m); p.media.push(m);
    }
    if (c.file && !m.path) { m.path = c.file; m.name = path.basename(String(c.file).replace(/\\/g, '/')); }
    const sp = c.speed > 0 ? c.speed : 1;
    m.duration = Math.max(m.duration, c.in + c.dur * sp + 0.5);
    const lane = Math.max(1, Math.round(c.lane || 1));
    if (c.kind === 'video') maxV = Math.max(maxV, lane); else maxA = Math.max(maxA, lane);
    const clip = DS.newClip({ track: (c.kind === 'video' ? 'V' : 'A') + lane, media: m.id, start: Math.max(0, c.start), in: Math.max(0, c.in), dur: c.dur, speed: sp, label: c.name || '' });
    if (c.dissolve > 0.01 && c.kind === 'video') clip.tr = { type: 'dissolve', dur: Math.min(c.dissolve, c.dur) };
    p.clips.push(clip);
  }
  p.tracks = [];
  for (let i = 1; i <= maxV; i++) p.tracks.push({ id: 'V' + i, type: 'video', name: 'V' + i, mute: false, hidden: false, lock: false });
  for (let i = 1; i <= maxA; i++) p.tracks.push({ id: 'A' + i, type: 'audio', name: 'A' + i, mute: false, hidden: false, lock: false });
  if (!p.clips.length) warnings.push('No clips were found in this file.');
  if (p.media.some((m) => !m.path || !path.isAbsolute(m.path) && !/^[A-Za-z]:[\\/]/.test(m.path))) warnings.push('Some media paths could not be determined from the file. Those clips show as offline: right-click the media in the Project panel and choose Locate file…');
  return Object.assign({ app: 'ditto-pro', v: 1 }, p);
}

function assignLanes(list, kind) {
  // greedy lane assignment for formats with no explicit track numbers (EDL)
  const ends = [];
  list.filter((c) => c.kind === kind).sort((a, b) => a.start - b.start).forEach((c) => {
    let i = ends.findIndex((e) => e <= c.start + 0.002);
    if (i < 0) { i = ends.length; ends.push(0); }
    ends[i] = c.start + c.dur; c.lane = i + 1;
  });
}

// ------------------------------------------------------------------------------------------------ EDL (CMX 3600)
function parseEDL(text, o) {
  o = o || {};
  const fps = o.fps || 30, warnings = [];
  let title = 'EDL import';
  const events = [];
  let cur = null;
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^TITLE:/i.test(line)) { title = line.replace(/^TITLE:\s*/i, '').trim() || title; continue; }
    if (/^FCM:/i.test(line)) continue;
    if (line[0] === '*') {
      const m = line.match(/^\*\s*(FROM CLIP NAME|SOURCE FILE|TO CLIP NAME|CLIP NAME)\s*:\s*(.*)$/i);
      if (m && cur) {
        const k = m[1].toUpperCase();
        if (k === 'SOURCE FILE') cur.file = m[2].trim(); else if (k !== 'TO CLIP NAME' || !cur.name) cur.name = cur.name || m[2].trim();
        if (k === 'FROM CLIP NAME') cur.name = m[2].trim();
      }
      continue;
    }
    const ev = line.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(C|D|W\d*|K\w*)\s+(?:(\d+)\s+)?(\d+:\d\d:\d\d[:;]\d\d)\s+(\d+:\d\d:\d\d[:;]\d\d)\s+(\d+:\d\d:\d\d[:;]\d\d)\s+(\d+:\d\d:\d\d[:;]\d\d)/);
    if (ev) {
      cur = { reel: ev[2], chan: ev[3].toUpperCase(), trans: ev[4].toUpperCase(), transDur: ev[5] ? +ev[5] : 0, sIn: tcToSeconds(ev[6], fps), sOut: tcToSeconds(ev[7], fps), rIn: tcToSeconds(ev[8], fps), rOut: tcToSeconds(ev[9], fps), name: '', file: '' };
      events.push(cur);
    }
  }
  if (!events.length) throw new Error('No events were found. Is this a CMX 3600 EDL?');
  const minR = Math.min.apply(null, events.map((e) => e.rIn));
  const origin = minR >= 3590 && minR < 7200 ? 3600 : 0; // 01:00:00:00 sequence start convention
  const clips = [];
  let camTc = false;
  for (const e of events) {
    if (e.reel === 'BL' || e.chan === 'NONE') continue;
    const dur = e.rOut - e.rIn;
    if (!(dur > 0)) continue;
    if (e.sIn >= 3600) camTc = true;
    const file = e.file || e.name || e.reel;
    const kinds = e.chan === 'B' ? ['video', 'audio'] : /^V/.test(e.chan) ? ['video'] : ['audio'];
    for (const kind of kinds) {
      const lane = kind === 'audio' && /^A(\d)$/.test(e.chan) ? +e.chan.slice(1) : 0;
      clips.push({ kind, lane, explicitLane: lane > 0, file, name: e.name || e.reel, start: e.rIn - origin, in: e.sIn, dur, speed: 1, dissolve: e.trans === 'D' ? e.transDur / fps : 0 });
    }
  }
  assignLanes(clips.map((c) => c), 'video');
  const aud = clips.filter((c) => c.kind === 'audio' && !c.explicitLane);
  assignLanes(aud, 'audio');
  if (camTc) warnings.push('The source timecodes look like camera timecode (01:00:00:00 or later). In-points are taken literally, so clips may start at the wrong place in the media.');
  if (events.some((e) => e.trans && e.trans !== 'C' && e.trans !== 'D')) warnings.push('Wipes and key effects in the EDL were imported as plain cuts.');
  warnings.push('An EDL only stores clip names, so media usually shows as offline: use Locate file… to link it.');
  return { name: title, width: o.width || 1920, height: o.height || 1080, fps, clips, warnings };
}

// ------------------------------------------------------------------------------------------------ xml helpers
const xmlParser = (preserve) => new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true, preserveOrder: !!preserve, processEntities: { enabled: true, maxEntitySize: 10000, maxTotalExpansions: 200000, maxExpandedLength: 20000000 } });

// ------------------------------------------------------------------------------------------------ Final Cut Pro XML (xmeml v4/v5; Premiere's "Export → Final Cut Pro XML")
function parseXmeml(doc) {
  const warnings = [];
  const root = doc.xmeml;
  const seqs = A(root.sequence).concat(A(root.project && root.project.children && root.project.children.sequence));
  const seq = seqs.find(Boolean) || (root.project && A(root.project.children && root.project.children.sequence)[0]);
  if (!seq) throw new Error('No sequence found in this XML file.');
  const rate = (r) => { const tb = numOf(r && r.timebase, 30); const ntsc = /true/i.test(txt(r && r.ntsc)); return ntsc ? tb * 1000 / 1001 : tb; };
  const fps = rate(seq.rate) || 30;
  const vfmt = seq.media && seq.media.video && seq.media.video.format && seq.media.video.format.samplecharacteristics;
  const width = vfmt ? numOf(vfmt.width, 1920) : 1920, height = vfmt ? numOf(vfmt.height, 1080) : 1080;

  const files = {}; // id -> { path, name }
  const grabFile = (f) => {
    if (!f) return null;
    const id = f['@_id'];
    if (f.pathurl != null || f.name != null) files[id] = { path: fileUrlToPath(txt(f.pathurl)), name: txt(f.name) };
    return files[id] || null;
  };
  const clips = [];
  const walkTracks = (tracks, kind) => {
    A(tracks).forEach((tr, ti) => {
      const items = A(tr && tr.clipitem);
      const trs = A(tr && tr.transitionitem);
      const made = [];
      items.forEach((ci) => {
        const f = grabFile(ci.file) || files[ci.file && ci.file['@_id']];
        const crate = rate(ci.rate) || fps;
        const start = numOf(ci.start, -1), end = numOf(ci.end, -1), inn = numOf(ci.in, 0), out = numOf(ci.out, 0);
        if (txt(ci.enabled) === 'FALSE') return;
        const len = Math.max(0, out - inn);
        const c = { kind, lane: kind === 'audio' ? Math.floor(ti / 2) + 1 : ti + 1, file: f ? (f.path || f.name) : txt(ci.name), name: txt(ci.name), start: start, in: inn / crate, dur: (end >= 0 && start >= 0 ? end - start : len) / fps, speed: 1, _frames: true };
        if (start < 0) c.start = NaN; else c.start = start / fps;
        made.push(c);
      });
      // clips next to a transition have start/end of -1: infer from neighbours
      let prevEnd = 0;
      made.forEach((c) => { if (!isFinite(c.start)) c.start = prevEnd; prevEnd = c.start + c.dur; });
      trs.forEach((t) => {
        const ts = numOf(t.start, 0) / fps, te = numOf(t.end, 0) / fps;
        const target = made.filter((c) => c.start >= ts - 0.5 / fps).sort((a, b) => a.start - b.start)[0];
        if (target && kind === 'video') target.dissolve = Math.max(0.05, te - ts);
      });
      made.forEach((c) => clips.push(c));
    });
  };
  if (seq.media) { walkTracks(seq.media.video && seq.media.video.track, 'video'); walkTracks(seq.media.audio && seq.media.audio.track, 'audio'); }
  warnings.push('Effects, colour corrections, speed changes and titles in the XML are not imported — only clips, cuts, positions and dissolves.');
  return { name: txt(seq.name) || 'XML import', width, height, fps, clips, warnings };
}

// ------------------------------------------------------------------------------------------------ FCPXML 1.x
function rational(s, d) {
  if (s == null || s === '') return d == null ? 0 : d;
  const m = String(s).match(/^(-?\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?s?$/);
  if (!m) return d == null ? 0 : d;
  return m[2] ? parseFloat(m[1]) / parseFloat(m[2]) : parseFloat(m[1]);
}
function parseFcpxml(doc) {
  const warnings = [];
  const root = doc.fcpxml;
  const res = root.resources || {};
  const formats = {}; A(res.format).forEach((f) => { formats[f['@_id']] = f; });
  const assets = {};
  A(res.asset).forEach((a) => {
    const rep = A(a['media-rep'])[0];
    assets[a['@_id']] = { name: a['@_name'], src: fileUrlToPath(a['@_src'] || (rep && rep['@_src'])), start: rational(a['@_start']), hasVideo: a['@_hasVideo'] !== '0', hasAudio: a['@_hasAudio'] !== '0' };
  });
  let seq = null, projName = 'FCPXML import';
  const lib = root.library;
  const findSeq = (n) => {
    if (!n || typeof n !== 'object' || seq) return;
    if (n.sequence) { seq = A(n.sequence)[0]; return; }
    for (const k of Object.keys(n)) if (!k.startsWith('@_')) A(n[k]).forEach(findSeq);
  };
  findSeq(lib || root);
  if (!seq) throw new Error('No sequence found in this FCPXML file.');
  const proj = lib && A(lib.event).map((e) => A(e.project)[0]).find(Boolean);
  if (proj && proj['@_name']) projName = proj['@_name'];
  const fmt = formats[seq['@_format']] || Object.values(formats)[0] || {};
  const fd = rational(fmt['@_frameDuration'], 1 / 30);
  const fps = fd > 0 ? 1 / fd : 30;
  const width = +fmt['@_width'] || 1920, height = +fmt['@_height'] || 1080;
  const tcStart = rational(seq['@_tcStart']);
  const clips = [];
  const CLIPLIKE = ['asset-clip', 'clip', 'video', 'audio', 'sync-clip'];
  const walk = (node, parentAbs, parentLocal, isSpine) => {
    CLIPLIKE.forEach((tag) => {
      A(node[tag]).forEach((ch) => {
        const off = rational(ch['@_offset']), start = rational(ch['@_start']), dur = rational(ch['@_duration']);
        const abs = isSpine ? off - tcStart : parentAbs + (off - parentLocal);
        let ref = ch['@_ref'];
        if (!ref) { const inner = ['video', 'audio', 'asset-clip'].map((t) => A(ch[t])[0]).find((x) => x && x['@_ref']); if (inner) ref = inner['@_ref']; }
        const asset = assets[ref];
        const lane = parseInt(ch['@_lane'] || '0', 10);
        if (asset) {
          const audioOnly = tag === 'audio' || !asset.hasVideo;
          const kind = audioOnly || lane < 0 ? 'audio' : 'video';
          const laneNo = lane < 0 ? -lane : kind === 'video' ? lane + 1 : Math.max(1, lane || 1);
          clips.push({ kind, lane: laneNo, file: asset.src || asset.name, name: ch['@_name'] || asset.name, start: abs, in: Math.max(0, start - asset.start), dur, speed: 1 });
        } else if (ref && tag !== 'sync-clip') warnings.push('A compound / multicam clip ("' + (ch['@_name'] || ref) + '") was skipped.');
        walk(ch, abs, start, false);
      });
    });
    A(node['spine']).forEach((sp) => walk(sp, parentAbs, parentLocal, false));
  };
  const spine = A(seq.spine)[0];
  if (spine) walk(spine, 0, 0, true);
  warnings.push('Effects, titles, colour corrections and retiming in the FCPXML are not imported — only clips, cuts and positions.');
  return { name: projName, width, height, fps, clips, warnings };
}

// ------------------------------------------------------------------------------------------------ Premiere Pro .prproj (EXPERIMENTAL)
/*
 * A .prproj is gzip-compressed XML describing an object graph (ObjectID / ObjectRef / ObjectUID / ObjectURef).
 * This reader walks Sequence → TrackGroups → ClipTracks → TrackItems → SubClip → Clip → MediaSource → Media.
 * It was written from the publicly observable structure of those files and tested against files constructed to that
 * structure; real project files vary between Premiere versions, so treat the result as a starting point.
 */
function parsePrproj(buf) {
  const warnings = [];
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  const xml = raw.toString('utf8');
  if (!/<PremiereData/.test(xml)) throw new Error('This does not look like a Premiere Pro project file.');
  const doc = xmlParser(false).parse(xml);
  const rootNode = doc.PremiereData;
  const byId = new Map(), byUid = new Map();
  for (const tag of Object.keys(rootNode)) {
    if (tag.startsWith('@_')) continue;
    A(rootNode[tag]).forEach((n) => {
      if (!n || typeof n !== 'object') return;
      n.__tag = tag;
      if (n['@_ObjectID'] != null) byId.set(String(n['@_ObjectID']), n);
      if (n['@_ObjectUID'] != null) byUid.set(String(n['@_ObjectUID']), n);
    });
  }
  const deref = (ref) => {
    if (!ref || typeof ref !== 'object') return null;
    if (ref['@_ObjectRef'] != null) return byId.get(String(ref['@_ObjectRef'])) || null;
    if (ref['@_ObjectURef'] != null) return byUid.get(String(ref['@_ObjectURef'])) || null;
    return null;
  };
  // first value for `key` anywhere below node
  const find = (node, key, depth) => {
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 8) return undefined;
    if (node[key] != null) return node[key];
    for (const k of Object.keys(node)) {
      if (k.startsWith('@_') || k === '__tag') continue;
      for (const v of A(node[k])) { if (v && typeof v === 'object' && !v['@_ObjectRef'] && !v['@_ObjectURef']) { const r = find(v, key, depth + 1); if (r !== undefined) return r; } }
    }
    return undefined;
  };

  const sequences = A(rootNode.Sequence);
  if (!sequences.length) throw new Error('No sequences were found in this project.');
  const collect = (seq) => {
    const out = [];
    const groups = A(seq.TrackGroups && seq.TrackGroups.TrackGroup);
    let width = 0, height = 0, ticksPerFrame = 0;
    for (const g of groups) {
      const grp = deref(g.Second);
      if (!grp) continue;
      const kind = /Audio/i.test(grp.__tag) ? 'audio' : /Video/i.test(grp.__tag) ? 'video' : null;
      if (!kind) continue;
      if (kind === 'video') {
        const fr = find(grp, 'FrameRect'); if (fr) { const p = txt(fr).split(',').map(Number); if (p.length === 4) { width = p[2] - p[0]; height = p[3] - p[1]; } }
        const rt = find(grp, 'FrameRate'); if (rt) ticksPerFrame = numOf(rt);
      }
      const tracks = A(grp.TrackGroup && grp.TrackGroup.Tracks && grp.TrackGroup.Tracks.Track);
      tracks.forEach((tref, ti) => {
        const track = deref(tref);
        if (!track) return;
        const items = A(track.ClipTrack && track.ClipTrack.ClipItems && track.ClipTrack.ClipItems.TrackItems && track.ClipTrack.ClipItems.TrackItems.TrackItem);
        items.forEach((iref) => {
          const item = deref(iref);
          if (!item) return;
          const start = numOf(find(item, 'Start')), end = numOf(find(item, 'End'));
          const sub = deref(find(item, 'SubClip'));
          const clipNode = sub && deref(find(sub, 'Clip'));
          if (!clipNode) return;
          const inPt = numOf(find(clipNode, 'InPoint')), outPt = numOf(find(clipNode, 'OutPoint'));
          const src = deref(find(clipNode, 'Source'));
          const media = src && deref(find(src, 'Media'));
          const file = media ? txt(find(media, 'ActualMediaFilePath') || find(media, 'FilePath')) : '';
          const name = txt(find(sub, 'Name')) || (media ? txt(find(media, 'Title')) : '');
          const dur = (end - start) / TICKS_PER_SECOND;
          const srcLen = (outPt - inPt) / TICKS_PER_SECOND;
          out.push({ kind, lane: ti + 1, file, name, start: start / TICKS_PER_SECOND, in: inPt / TICKS_PER_SECOND, dur, speed: dur > 0 && srcLen > 0 ? srcLen / dur : 1 });
        });
      });
    }
    return { clips: out, width, height, ticksPerFrame };
  };
  let best = null;
  sequences.forEach((s) => { const r = collect(s); r.name = txt(s.Name) || txt(find(s, 'Name')) || 'Sequence'; if (!best || r.clips.length > best.clips.length) best = r; });
  if (sequences.length > 1) warnings.push('The project has ' + sequences.length + ' sequences; the one with the most clips ("' + best.name + '") was imported.');
  const fps = best.ticksPerFrame > 0 ? TICKS_PER_SECOND / best.ticksPerFrame : 0;
  if (!fps) warnings.push('The frame rate could not be read; 30 fps was assumed. Check Sequence → Sequence settings.');
  if (!best.width) warnings.push('The frame size could not be read; 1920×1080 was assumed. Check Sequence → Sequence settings.');
  if (!best.clips.length) warnings.push('No clips were found. Premiere project files change between versions; exporting from Premiere with File → Export → Final Cut Pro XML and importing that is more reliable.');
  warnings.push('Premiere project import is experimental: clips and cuts only. Effects, titles, nested sequences and speed ramps are not carried over.');
  return { name: best.name, width: best.width || 1920, height: best.height || 1080, fps: fps || 30, clips: best.clips, warnings };
}

// ------------------------------------------------------------------------------------------------ OpenTimelineIO (.otio, JSON)
const rt = (v) => (v && typeof v === 'object' && Number.isFinite(+v.value) && +v.rate > 0 ? +v.value / +v.rate : null);
function parseOtio(text) {
  const warnings = [];
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error('This is not a valid OpenTimelineIO file (the JSON could not be read).'); }
  const schema = (n) => String((n && n.OTIO_SCHEMA) || '').split('.')[0];
  let tl = doc;
  if (schema(doc) === 'SerializableCollection') { tl = A(doc.children).find((c) => schema(c) === 'Timeline'); if (!tl) throw new Error('No timeline was found in this OpenTimelineIO collection.'); }
  if (schema(tl) !== 'Timeline') throw new Error('This OpenTimelineIO file has no Timeline (found "' + (schema(tl) || 'unknown') + '").');
  const root = tl.tracks;
  if (!root || schema(root) !== 'Stack') throw new Error('The timeline has no tracks.');
  const rates = {};
  const durOf = (it, depth) => {
    const d = it && it.source_range && rt(it.source_range.duration);
    if (d != null) return d;
    if (depth > 24) return 0;
    const kids = A(it && it.children);
    if (schema(it) === 'Stack') return Math.max(0, ...kids.map((k) => durOf(k, depth + 1)));
    return kids.reduce((s, k) => (schema(k) === 'Transition' ? s : s + durOf(k, depth + 1)), 0);
  };
  const out = [];
  let lane = { video: 0, audio: 0 }, nested = 0, skippedRef = 0, effects = 0;
  const tracks = A(root.children).filter((t) => schema(t) === 'Track');
  for (const tr of tracks) {
    const kind = /^audio$/i.test(tr.kind) ? 'audio' : 'video';
    const l = ++lane[kind];
    let t = 0, pend = 0;
    const kids = A(tr.children);
    kids.forEach((it, idx) => {
      const sc = schema(it);
      if (sc === 'Gap') { t += durOf(it, 0); return; }
      if (sc === 'Transition') {
        const inO = rt(it.in_offset) || 0, outO = rt(it.out_offset) || 0;
        const next = kids[idx + 1];
        if (next && schema(next) === 'Clip' && /dissolve/i.test(String(it.transition_type || 'SMPTE_Dissolve'))) pend = inO + outO;
        else if (!/dissolve/i.test(String(it.transition_type || 'SMPTE_Dissolve'))) warnings.push('A "' + it.transition_type + '" transition was turned into a straight cut.');
        return;
      }
      if (sc !== 'Clip') { nested++; t += durOf(it, 0); return; }
      const sr = it.source_range;
      const dur0 = sr && rt(sr.duration), start0 = sr && rt(sr.start_time);
      const refs = it.media_references && typeof it.media_references === 'object' ? it.media_references : null;
      const ref = (refs && it.active_media_reference_key && refs[it.active_media_reference_key]) || it.media_reference;
      let d = dur0, inPt = start0;
      if (d == null && ref && ref.available_range) { d = rt(ref.available_range.duration); inPt = rt(ref.available_range.start_time); }
      if (d == null) { skippedRef++; return; }
      if (sr && sr.duration && sr.duration.rate) rates[sr.duration.rate] = (rates[sr.duration.rate] || 0) + 1;
      let speed = 1;
      A(it.effects).forEach((ef) => { if (/TimeWarp/.test(schema(ef)) && Number.isFinite(+ef.time_scalar) && +ef.time_scalar > 0) speed = +ef.time_scalar; else effects++; });
      let file = '';
      if (ref && schema(ref) === 'ExternalReference') file = fileUrlToPath(ref.target_url);
      else if (ref && schema(ref) === 'ImageSequenceReference') { skippedRef++; t += d / speed; return; }
      const name = it.name || (file ? path.basename(file) : 'Clip');
      const cl = { kind, lane: l, file, name, start: t, in: Math.max(0, inPt || 0), dur: d / speed, speed };
      if (pend && kind === 'video') cl.dissolve = pend;
      pend = 0;
      out.push(cl);
      t += d / speed;
    });
  }
  const best = Object.entries(rates).sort((a, b) => b[1] - a[1])[0];
  const fps = best ? +best[0] : 0;
  if (!fps) warnings.push('The frame rate could not be read from the file; 30 fps was assumed.');
  warnings.push('OpenTimelineIO has no picture size, so the sequence is 1920×1080: check Sequence → Sequence settings.');
  if (nested) warnings.push(nested + ' nested stack' + (nested > 1 ? 's were' : ' was') + ' skipped (its time is kept as a gap).');
  if (skippedRef) warnings.push(skippedRef + ' clip' + (skippedRef > 1 ? 's' : '') + ' without a media file (image sequence, generator or missing reference) ' + (skippedRef > 1 ? 'were' : 'was') + ' left out.');
  if (effects) warnings.push('Effects in the file were not carried over (only speed changes and dissolves are).');
  return { name: tl.name || 'OpenTimelineIO import', width: 1920, height: 1080, fps: fps || 30, clips: out, warnings };
}

// ------------------------------------------------------------------------------------------------ entry point
function importProjectFile(file, o) {
  o = o || {};
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  let model;
  if (ext === '.prproj') model = parsePrproj(buf);
  else if (ext === '.otio') model = parseOtio(buf.toString('utf8'));
  else if (ext === '.edl') model = parseEDL(buf.toString('utf8'), o);
  else if (ext === '.xml' || ext === '.fcpxml') {
    const doc = xmlParser(false).parse(buf.toString('utf8'));
    if (doc.xmeml) model = parseXmeml(doc);
    else if (doc.fcpxml) model = parseFcpxml(doc);
    else throw new Error('This XML file is not Final Cut Pro XML (xmeml) or FCPXML.');
  } else throw new Error('Unsupported file type: ' + ext);
  const warnings = model.warnings || [];
  const project = buildProject(model, warnings);
  if (!model.name || /import$/.test(model.name)) project.name = path.basename(file, ext);
  return { project, warnings, stats: { clips: project.clips.length, media: project.media.length } };
}

module.exports = { importProjectFile, parseOtio, parseEDL, parseXmeml, parseFcpxml, parsePrproj, buildProject, tcToSeconds, fileUrlToPath, TICKS_PER_SECOND };
