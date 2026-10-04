'use strict';
/* Ditto Pro — offline media analysis (silence + scene-cut detection). Everything runs locally through FFmpeg. */
const { spawn } = require('child_process');

function runFfmpeg(ffmpeg, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* ignore */ } reject(new Error('Analysis timed out.')); }, timeoutMs || 10 * 60 * 1000);
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 8e6) err = err.slice(-4e6); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(err); else reject(new Error(err.slice(-400) || 'ffmpeg failed')); });
  });
}

/** Silent stretches of the file's audio, in source seconds: [{start, end}] */
async function detectSilence(ffmpeg, file, o) {
  o = o || {};
  const noise = o.noiseDb == null ? -35 : o.noiseDb, minDur = Math.max(0.05, o.minDur == null ? 0.5 : o.minDur);
  const a = ['-hide_banner', '-nostdin', '-i', file];
  if (o.from != null) a.splice(2, 0, '-ss', String(o.from));
  if (o.to != null) a.splice(2, 0, '-to', String(o.to));
  a.push('-vn', '-af', 'silencedetect=noise=' + noise + 'dB:d=' + minDur, '-f', 'null', '-');
  const log = await runFfmpeg(ffmpeg, a);
  const off = o.from || 0, out = [];
  let start = null;
  for (const line of log.split(/\r?\n/)) {
    let m = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (m) { start = Math.max(0, parseFloat(m[1])) + off; continue; }
    m = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (m) { out.push({ start: start == null ? off : start, end: parseFloat(m[1]) + off }); start = null; }
  }
  if (start != null && o.to != null) out.push({ start, end: o.to });
  return out;
}

/** Scene-change times in source seconds. */
async function detectScenes(ffmpeg, file, o) {
  o = o || {};
  const th = o.threshold == null ? 0.3 : o.threshold;
  const a = ['-hide_banner', '-nostdin', '-i', file, '-an', '-vf', "select='gt(scene," + th + ")',showinfo", '-f', 'null', '-'];
  const log = await runFfmpeg(ffmpeg, a);
  const t = [];
  for (const line of log.split(/\r?\n/)) { const m = line.match(/pts_time:\s*([\d.]+)/); if (m && /Parsed_showinfo/.test(line)) t.push(parseFloat(m[1])); }
  return t;
}

/** Loudest sample and average level of the file's audio in dBFS: { peak, mean } (null when it has no sound). */
async function detectPeak(ffmpeg, file, o) {
  o = o || {};
  const a = ['-hide_banner', '-nostdin', '-i', file];
  if (Number.isFinite(+o.from)) a.splice(2, 0, '-ss', String(+o.from));
  if (Number.isFinite(+o.to)) a.splice(2, 0, '-to', String(+o.to));
  a.push('-vn', '-af', 'volumedetect', '-f', 'null', '-');
  let log;
  try { log = await runFfmpeg(ffmpeg, a); }
  catch (e) { if (/does not contain any stream|matches no streams/i.test(String(e.message))) return null; throw e; }
  const pk = log.match(/max_volume:\s*(-?[\d.]+) dB/), mn = log.match(/mean_volume:\s*(-?[\d.]+) dB/);
  if (!pk) return null;
  return { peak: parseFloat(pk[1]), mean: mn ? parseFloat(mn[1]) : null };
}

module.exports = { detectSilence, detectScenes, detectPeak };
