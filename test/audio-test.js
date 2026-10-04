/* Track effect racks and 5.1 surround: real renders, measured channel by channel. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const DS = require('../src/shared');
const { buildExport } = require('../src/exporter');
const FFMPEG = require('ffmpeg-static'), FFPROBE = require('ffprobe-static').path;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-aud-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const sh = (a) => { const r = spawnSync(FFMPEG, a, { encoding: 'utf8', maxBuffer: 1 << 26 }); if (r.status) throw new Error(r.stderr.slice(-800)); return r; };
const tone = (name, f) => { const o = path.join(tmp, name); sh(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=' + f + ':d=3:r=48000,volume=0.5', '-ac', '2', o]); return o; };
const t100 = tone('t100.wav', 100), t1k = tone('t1k.wav', 1000), t3k = tone('t3k.wav', 3000);
const lvl = (file, af) => {          // mean level in dB of the file (optionally after filters)
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-af', (af ? af + ',' : '') + 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr); return m ? parseFloat(m[1]) : -120;
};
const chans = (file) => { const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', file], { encoding: 'utf8' }); return parseInt(r.stdout, 10); };
const chLevel = (file, i, af) => lvl(file, 'pan=mono|c0=c' + i + (af ? ',' + af : ''));

function render(name, P, fmtId, extra) {
  const out = path.join(tmp, name), sc = path.join(tmp, name + '.txt');
  const b = buildExport(P, Object.assign({ outPath: out, scriptPath: sc, newFilterFlag: false, format: fmtId || 'wav' }, extra || {}), {});
  fs.writeFileSync(sc, b.script);
  const r = spawnSync(FFMPEG, b.args, { encoding: 'utf8', cwd: tmp, maxBuffer: 1 << 26 });
  if (r.status) { console.log(r.stderr.slice(-1500)); console.log(b.script); return null; }
  return out;
}
const mkP = (layout) => {
  const P = DS.newProject({ width: 320, height: 180, fps: 30, name: 'a' });
  if (layout) P.audioLayout = layout;
  P.media = [t100, t1k, t3k].map((p, i) => ({ id: 'm' + i, path: p, name: path.basename(p), kind: 'audio', duration: 3, hasAudio: true }));
  return P;
};
const clip = (track, m, dur) => DS.newClip({ track, media: m, start: 0, in: 0, dur: dur || 2 });

console.log('Per-track racks:');
{
  const P = mkP(); P.clips = [clip('A1', 'm1')];
  const base = lvl(render('base.wav', P));
  P.tracks.find((t) => t.id === 'A1').vol = -12;
  const down = lvl(render('fader.wav', P));
  ok(Math.abs((base - down) - 12) < 0.6, 'track fader -12 dB lowers the track by 12 dB (' + (base - down).toFixed(2) + ')');
}
{
  const P = mkP(); P.clips = [clip('A1', 'm0'), clip('A2', 'm1')];          // 100 Hz on A1, 1 kHz on A2
  const both = render('two.wav', P);
  P.tracks.find((t) => t.id === 'A1').ae = Object.assign(DS.clone(DS.DEFAULT_AE), { hp: 600 });
  const racked = render('rack.wav', P);
  const low = (f) => lvl(f, 'lowpass=f=300'), high = (f) => lvl(f, 'highpass=f=700');
  ok(low(both) > -40 && low(racked) < low(both) - 15, 'high-pass on A1 removes its 100 Hz (' + low(both).toFixed(1) + ' → ' + low(racked).toFixed(1) + ' dB)');
  ok(Math.abs(high(racked) - high(both)) < 0.7, 'the other track (A2, 1 kHz) is untouched (' + high(both).toFixed(1) + ' vs ' + high(racked).toFixed(1) + ' dB)');
}
{
  const P = mkP(); P.clips = [clip('A1', 'm0'), clip('A1', 'm1')]; P.clips[1].start = 0;      // two clips on one track, rack on that track
  P.tracks.find((t) => t.id === 'A1').ae = Object.assign(DS.clone(DS.DEFAULT_AE), { lp: 400 });
  const o = render('sum.wav', P);
  const lo = lvl(o, 'lowpass=f=300'), hi = lvl(o, 'highpass=f=700');
  ok(!!o && lo > -40 && hi < lo - 15, 'two clips on one rack track are summed, then low-passed (low ' + lo.toFixed(1) + ', high ' + hi.toFixed(1) + ' dB)');
}

console.log('5.1 surround:');
const names = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'];
const profile = (file) => names.map((n, i) => chLevel(file, i));
{
  const P = mkP('5.1'); P.clips = [clip('A1', 'm1')];
  const f = render('s_default.wav', P);
  ok(!!f && chans(f) === 6, 'a 5.1 project writes six channels');
  const pr = profile(f);
  ok(pr[0] > -40 && pr[1] > -40 && pr[2] < -70 && pr[3] < -70 && pr[4] < -70 && pr[5] < -70, 'unplaced clip plays in front left / right only (' + pr.map((v) => v.toFixed(0)).join(' ') + ')');
}
{
  const P = mkP('5.1'); const c = clip('A1', 'm1'); c.ae = Object.assign(DS.clone(DS.DEFAULT_AE), { sx: -100, sy: 100 }); P.clips = [c];
  const pr = profile(render('s_bl.wav', P));
  ok(pr[4] > -40 && [0, 1, 2, 3, 5].every((i) => pr[i] < -60), 'placed back-left: sound only in the back-left channel (' + pr.map((v) => v.toFixed(0)).join(' ') + ')');
}
{
  const P = mkP('5.1'); const c = clip('A1', 'm1'); c.ae = Object.assign(DS.clone(DS.DEFAULT_AE), { sc: 100 }); P.clips = [c];
  const pr = profile(render('s_c.wav', P));
  ok(pr[2] > -40 && pr[0] < -60 && pr[1] < -60, 'centre send 100%: sound in the centre channel only (' + pr.map((v) => v.toFixed(0)).join(' ') + ')');
}
{
  const P = mkP('5.1'); const c1 = clip('A1', 'm0'), c2 = clip('A1', 'm2');             // 100 Hz + 3 kHz, both sent to the LFE
  [c1, c2].forEach((c) => { c.ae = Object.assign(DS.clone(DS.DEFAULT_AE), { slfe: 100 }); });
  P.clips = [c1, c2];
  const f = render('s_lfe.wav', P);
  const lfeLow = chLevel(f, 3, 'lowpass=f=300'), lfeHigh = chLevel(f, 3, 'highpass=f=1500');
  ok(lfeLow > -45 && lfeHigh < lfeLow - 30, 'LFE carries the bass and not the highs (low ' + lfeLow.toFixed(1) + ' dB, high ' + lfeHigh.toFixed(1) + ' dB)');
}
{
  const P = mkP('5.1'); P.clips = [clip('A1', 'm1')];
  P.tracks.find((t) => t.id === 'A1').vol = -10;
  const f = render('s_rack.wav', P), g = render('s_norack.wav', (() => { const Q = mkP('5.1'); Q.clips = [clip('A1', 'm1')]; return Q; })());
  ok(Math.abs((chLevel(g, 0) - chLevel(f, 0)) - 10) < 0.7, 'track fader works in 5.1 too');
}
console.log('Formats:');
{
  const P = mkP('5.1'); P.clips = [clip('A1', 'm1')];
  const fm = (id, ext) => render('fmt_' + id + '.' + ext, P, id);
  ok(chans(fm('m4a', 'm4a')) === 6, 'M4A (AAC) carries 5.1');
  ok(chans(fm('mp3', 'mp3')) === 2, 'MP3 is mixed down to stereo');
  ok(chans(fm('wav', 'wav')) === 6, 'WAV carries 5.1');
  const V = mkP('5.1'); V.media.push({ id: 'v', path: (() => { const o = path.join(tmp, 'v.mp4'); sh(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=3', '-pix_fmt', 'yuv420p', o]); return o; })(), name: 'v.mp4', kind: 'video', duration: 3, hasAudio: false, w: 320, h: 180 });
  V.clips = [clip('A1', 'm1'), DS.newClip({ track: 'V1', media: 'v', start: 0, in: 0, dur: 2 })];
  const mp4 = render('v51.mp4', V, 'mp4-h264', { quality: 40 });
  ok(!!mp4 && chans(mp4) === 6, 'MP4 video + 5.1 AAC');
  const webm = render('v51.webm', V, 'webm-vp9', { quality: 30 });
  ok(!!webm && chans(webm) === 6, 'WebM Opus 5.1');
  const norm = render('norm51.wav', P, 'wav', { normalize: true });
  ok(!!norm && chans(norm) === 6, 'loudness normalising keeps six channels');
  const stereoOverride = render('as_stereo.wav', P, 'wav', { audioLayout: 'stereo' });
  ok(!!stereoOverride && chans(stereoOverride) === 2, 'the export dialog can still write a stereo file from a 5.1 project');
}
process.exit(failed ? 1 : 0);
