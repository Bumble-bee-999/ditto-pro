'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const F = require('ffmpeg-static');
const DS = require('../src/shared');
const { buildExport } = require('../src/exporter');
let fail = 0; const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
console.log('Volume keyframes:');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vol-'));
const tone = path.join(tmp, 'tone.wav');
spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=5', '-c:a', 'pcm_s16le', tone]);
function render(setup) {
  const P = DS.newProject({ width: 320, height: 180, fps: 30, name: 'v' });
  P.media = [{ id: 'a', path: tone, name: 'tone', kind: 'audio', duration: 5, hasAudio: true }];
  const c = DS.newClip({ track: 'A1', media: 'a', start: 0, in: 0, dur: 4 });
  setup(c);
  P.clips = [c];
  const out = path.join(tmp, 'o' + Math.random().toString(36).slice(2) + '.wav');
  const b = buildExport(P, { outPath: out, scriptPath: path.join(tmp, 's.txt'), newFilterFlag: false, format: 'wav' }, {});
  fs.writeFileSync(path.join(tmp, 's.txt'), b.script);
  const r = spawnSync(F, b.args, { cwd: tmp });
  if (r.status) return { err: String(r.stderr).slice(-400) };
  const raw = spawnSync(F, ['-v', 'error', '-i', out, '-f', 's16le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 1 << 28 }).stdout;
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
  const db = (t0, t1) => { let s = 0; const a = Math.round(t0 * 48000), b2 = Math.round(t1 * 48000); for (let i = a; i < b2; i++) s += pcm[i] * pcm[i]; return 10 * Math.log10(s / (b2 - a) / (32768 * 32768) + 1e-12); };
  return { db };
}
const ref = render(() => {});
ok(!ref.err, 'plain clip exports ' + (ref.err || ''));
const L0 = ref.db(1, 1.2);
const r1 = render((c) => { c.kf.vol = [{ t: 0, v: 0, e: 'lin' }, { t: 2, v: -40, e: 'lin' }]; });
ok(!r1.err, 'keyframed clip exports ' + (r1.err || ''));
if (!r1.err) {
  const at = (t) => r1.db(t - 0.02, t + 0.02) - L0;
  ok(Math.abs(at(0.05) - (-1)) < 1.2, 'starts at full level (' + at(0.05).toFixed(1) + ' dB)');
  ok(Math.abs(at(1) - (-20)) < 1.2, 'half-way through the ramp it is 20 dB down (' + at(1).toFixed(1) + ' dB)');
  ok(Math.abs(at(1.5) - (-30)) < 1.2, 'three quarters through it is 30 dB down (' + at(1.5).toFixed(1) + ' dB)');
  ok(Math.abs(at(3) - (-40)) < 1.2, 'after the last keyframe it stays 40 dB down (' + at(3).toFixed(1) + ' dB)');
}
const r2 = render((c) => { c.vol = -6; c.kf.vol = [{ t: 1, v: -12, e: 'hold' }, { t: 2, v: 0, e: 'lin' }]; });
if (!r2.err) {
  const at = (t) => r2.db(t - 0.05, t + 0.05) - L0;
  ok(Math.abs(at(0.5) - (-12)) < 1 && Math.abs(at(1.5) - (-12)) < 1 && Math.abs(at(2.5)) < 1, 'hold keyframes step (' + [0.5, 1.5, 2.5].map((t) => at(t).toFixed(1)).join(', ') + ' dB)');
} else ok(false, r2.err);
const r3 = render((c) => { c.kf.vol = [{ t: 1, v: -9, e: 'lin' }]; });
ok(!r3.err && Math.abs(r3.db(2, 2.2) - L0 - (-9)) < 0.6, 'a single keyframe is a constant level');
ok(DS.volAt({ vol: -3, kf: { vol: [] } }, 1) === -3 && Math.abs(DS.volAt({ vol: 0, kf: { vol: [{ t: 0, v: 0, e: 'lin' }, { t: 2, v: -40, e: 'lin' }] } }, 1) + 20) < 1e-9 && DS.volAt({ vol: 0, kf: { vol: [{ t: 0, v: 500, e: 'lin' }] } }, 0) === 24, 'DS.volAt gives the same curve and clamps');
const k = DS.cleanKf({ vol: [{ t: 0, v: '1:enable=1' }, { t: 1, v: -5 }] });
ok(k.vol.length === 1 && k.vol[0].v === -5, 'hostile volume keyframes are dropped');
{
  let threw = '';
  try { render((c) => { c.mute = true; }); } catch (e) { threw = e.message; }
  ok(/no audio/i.test(threw), 'a muted clip contributes no sound to the export (' + threw.slice(0, 50) + ')');
}
console.log('Echo:');
{
  const ae = Object.assign({}, DS.DEFAULT_AE, { comp: Object.assign({}, DS.DEFAULT_AE.comp), echo: { on: true, delay: 100, decay: 50 } });
  const taps = DS.echoTaps(ae);
  ok(taps.length === 3 && taps[0].ms === 100 && taps[2].ms === 300 && taps[0].gain === 0.5 && taps[2].gain === 0.125, 'three repeats, each half of the one before');
  ok(DS.echoTaps(DS.DEFAULT_AE).length === 0 && DS.aeFilters(DS.DEFAULT_AE).length === 0, 'off by default');
  const N = 48000, input = new Float32Array(N * 2); input[2 * 1000] = 0.5; input[2 * 1000 + 1] = 0.5;
  fs.writeFileSync(path.join(tmp, 'imp.raw'), Buffer.from(input.buffer));
  const r = spawnSync(F, ['-y', '-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', path.join(tmp, 'imp.raw'), '-af', DS.aeFilters(ae).join(','), '-f', 'f32le', path.join(tmp, 'imp_out.raw')]);
  const b = fs.readFileSync(path.join(tmp, 'imp_out.raw')), out = new Float32Array(b.buffer, b.byteOffset, b.length >> 2);
  const at = (i) => out[2 * i];
  ok(r.status === 0 && Math.abs(at(1000) - 0.5) < 1e-3 && Math.abs(at(1000 + 4800) - 0.25) < 1e-3 && Math.abs(at(1000 + 9600) - 0.125) < 1e-3 && Math.abs(at(1000 + 14400) - 0.0625) < 1e-3, 'FFmpeg gives the dry sound plus the three repeats (' + [1000, 5800, 10600, 15400].map((i) => at(i).toFixed(3)).join(', ') + ')');
  const hostile = DS.aeFilters(Object.assign({}, DS.DEFAULT_AE, { comp: Object.assign({}, DS.DEFAULT_AE.comp), echo: { on: true, delay: '5|1:x', decay: 'NaN,volume=9' } })).join(',');
  ok(/^aecho=in_gain=1:out_gain=1:delays=[\d|]+:decays=[\d.|]+$/.test(hostile), 'hostile echo values become plain numbers (' + hostile + ')');
}
console.log('Auto-duck:');
{
  const music = { start: 0, in: 0, dur: 10, speed: 1, vol: -3, kf: { vol: [] } };
  const speech = { start: 2, in: 5, dur: 4, speed: 1 };                   // plays source 5..9 at timeline 2..6
  const spans = DS.speechSpans(speech, [{ start: 6, end: 7 }, { start: 8.5, end: 20 }]);   // quiet at source 6..7 and from 8.5
  ok(spans.length === 2 && Math.abs(spans[0].t0 - 2) < 1e-9 && Math.abs(spans[0].t1 - 3) < 1e-9 && Math.abs(spans[1].t0 - 4) < 1e-9 && Math.abs(spans[1].t1 - 5.5) < 1e-9, 'speech spans map from source to timeline time (' + JSON.stringify(spans) + ')');
  const kf = DS.duckKeyframes(music, spans, { amount: 12, fade: 0.25 });
  const at = (t) => DS.volAt(Object.assign({}, music, { kf: { vol: kf } }), t);
  ok(at(0) === -3 && at(1.5) === -3, 'full volume before the speech');
  ok(Math.abs(at(1.875) - (-9)) < 0.01, 'half-way through the fade it is half-way down (' + at(1.875).toFixed(2) + ')');
  ok(at(2.5) === -15 && at(3) === -15 && at(4.5) === -15, 'ducked 12 dB while speech plays');
  ok(at(3.5) === -3, 'back up in a pause longer than two fades (' + at(3.5) + ')');
  ok(at(6) === -3 && at(10) === -3, 'full volume after the speech');
  ok(kf.every((k, i) => i === 0 || k.t > kf[i - 1].t) && kf[0].t === 0 && kf[kf.length - 1].t === 10, 'keyframes are ordered and cover the clip');
  const closeGap = DS.duckKeyframes(music, [{ t0: 2, t1: 3 }, { t0: 3.3, t1: 4 }], { amount: 12, fade: 0.25 });
  const at2 = (t) => DS.volAt(Object.assign({}, music, { kf: { vol: closeGap } }), t);
  ok(at2(3.15) === -15, 'a short pause does not pump the music back up');
  const edge = DS.duckKeyframes({ start: 5, in: 0, dur: 4, speed: 1, vol: 0, kf: { vol: [] } }, [{ t0: 0, t1: 6 }, { t0: 8.9, t1: 12 }], { amount: 10, fade: 0.5 });
  ok(edge[0].t === 0 && edge[0].v === -10 && edge[edge.length - 1].v === -10, 'speech that is already running at the clip\'s edges starts and ends ducked');
  ok(DS.duckKeyframes(music, [{ t0: 20, t1: 30 }], {}).length === 0, 'no overlap, no keyframes');
  ok(DS.duckKeyframes({ start: 0, dur: 5, vol: -55, kf: { vol: [] } }, [{ t0: 1, t1: 2 }], { amount: 30 }).every((k) => k.v >= -60), 'never below the volume range');
}
process.exit(fail ? 1 : 0);
