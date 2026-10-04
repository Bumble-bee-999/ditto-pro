'use strict';
/* SubRip (.srt) reading and writing. */
function ts(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return p(h) + ':' + p(m) + ':' + p(s) + ',' + p(r, 3);
}
function parseTs(s) {
  const m = String(s).trim().match(/^(?:(\d+):)?(\d\d):(\d\d)[,.](\d{1,3})$/);   // WebVTT may leave the hours out
  if (!m) return null;
  return +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +(m[4].padEnd(3, '0')) / 1000;
}
/** @returns [{ start, end, text }] in seconds */
function parseSrt(text) {
  const cues = [];
  const blocks = String(text).replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => /-->/.test(l));
    if (i < 0) continue;
    const m = lines[i].match(/^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!m) continue;
    const start = parseTs(m[1]), end = parseTs(m[2]);
    if (start == null || end == null || end <= start) continue;
    const t = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (t) cues.push({ start, end, text: t });
  }
  return cues;
}
function formatSrt(cues) {
  return cues.map((c, i) => (i + 1) + '\n' + ts(c.start) + ' --> ' + ts(c.end) + '\n' + c.text + '\n').join('\n');
}

const entities = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
/** Advanced SubStation Alpha / SubStation Alpha (.ass, .ssa): the Dialogue lines of the [Events] section */
function parseAss(text) {
  const cues = [];
  let fmt = null, inEvents = false;
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inEvents = /^\[events\]$/i.test(line); continue; }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) { fmt = line.replace(/^format\s*:/i, '').split(',').map((x) => x.trim().toLowerCase()); continue; }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const cols = fmt || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const body = line.replace(/^dialogue\s*:\s*/i, '');
    const parts = body.split(',');
    const ti = cols.indexOf('text');
    const val = (k) => parts[cols.indexOf(k)];
    const tm = (v) => { const m = String(v || '').trim().match(/^(\d+):(\d\d):(\d\d)[.](\d{1,3})$/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +('0.' + m[4]) : null; };
    const start = tm(val('start')), end = tm(val('end'));
    if (start == null || end == null || end <= start || ti < 0) continue;
    const t = entities(parts.slice(ti).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ')).trim();
    if (t) cues.push({ start, end, text: t });
  }
  return cues.sort((a, b) => a.start - b.start);
}
/** YouTube SBV: "0:00:01.000,0:00:03.500" then the text */
function parseSbv(text) {
  const cues = [];
  for (const b of String(text).replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const m = lines[0] && lines[0].match(/^(\d+:\d\d:\d\d\.\d{1,3}),(\d+:\d\d:\d\d\.\d{1,3})$/);
    if (!m) continue;
    const start = parseTs(m[1]), end = parseTs(m[2]);
    if (start != null && end != null && end > start && lines.length > 1) cues.push({ start, end, text: lines.slice(1).join('\n') });
  }
  return cues;
}
/** Any caption file: the kind is taken from the contents, so a wrong extension still works. Returns cues sorted by time. */
function parseCaptions(text, ext) {
  const t = String(text).replace(/^﻿/, '');
  ext = String(ext || '').toLowerCase().replace(/^\./, '');
  let cues;
  if (ext === 'ass' || ext === 'ssa' || /^\s*\[Script Info\]/i.test(t) || /^dialogue\s*:/im.test(t)) cues = parseAss(t);
  else if (ext === 'sbv' || /^\d+:\d\d:\d\d\.\d+,\d+:\d\d:\d\d\.\d+\s*$/m.test(t.slice(0, 400)) && !/-->/.test(t.slice(0, 2000))) cues = parseSbv(t);
  else cues = parseSrt(t).map((c) => Object.assign(c, { text: entities(c.text) }));
  return cues.slice(0, 20000).sort((a, b) => a.start - b.start);
}
module.exports = { parseSrt, formatSrt, parseAss, parseSbv, parseCaptions };
