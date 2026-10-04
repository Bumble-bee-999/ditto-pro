'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const F = require('ffmpeg-static');
const DS = require('../src/shared');
const { detectSilence, detectScenes, detectPeak } = require('../src/analysis');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-an-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const sh = (a) => { const r = spawnSync(F, a, { encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); };
(async () => {
  console.log('Silence detection:');
  const wav = path.join(tmp, 'speech.wav');
  // tone 0-1s, silence 1-3s, tone 3-4s
  sh(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1:r=44100', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=1:r=44100', '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', wav]);
  const sil = await detectSilence(F, wav, { noiseDb: -40, minDur: 0.5 });
  ok(sil.length === 1 && Math.abs(sil[0].start - 1) < 0.1 && Math.abs(sil[0].end - 3) < 0.1, 'finds one silence at 1.0–3.0 s (' + JSON.stringify(sil) + ')');
  const clip = DS.newClip({ track: 'A1', media: 'm', start: 5, in: 0, dur: 4 });
  const keep = DS.keepSegments(clip, sil);
  ok(keep.length === 2 && keep[0].in === 0 && keep[0].dur > 0.9 && keep[0].dur < 1.1 && keep[1].in > 2.9 && keep[1].in < 3.1, 'keepSegments yields the two spoken parts (' + keep.map((k) => k.in.toFixed(2) + '+' + k.dur.toFixed(2)).join(', ') + ')');
  const sped = DS.newClip({ track: 'A1', media: 'm', start: 0, in: 1, dur: 1, speed: 2 }); // covers source 1..3
  const k2 = DS.keepSegments(sped, sil);
  ok(k2.length === 0, 'a clip lying entirely inside silence keeps nothing');

  console.log('Scene detection:');
  const vid = path.join(tmp, 'scenes.mp4');
  sh(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=25:d=1', '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-pix_fmt', 'yuv420p', vid]);
  const sc = await detectScenes(F, vid, { threshold: 0.3 });
  ok(sc.length === 2 && Math.abs(sc[0] - 1) < 0.1 && Math.abs(sc[1] - 2) < 0.1, 'finds cuts at 1 s and 2 s (' + JSON.stringify(sc) + ')');
  console.log('Peak level:');
  const quiet = path.join(tmp, 'quiet.wav');
  sh(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=2:r=48000', '-af', 'volume=-12dB', quiet]);   // lavfi sine peaks at 1/8 = -18.06 dBFS
  const lv = await detectPeak(F, quiet, {});
  ok(lv && Math.abs(lv.peak - (-30.06)) < 0.5, 'reads the loudest sample (' + (lv && lv.peak) + ' dB, expected about -30.1)');
  const lv2 = await detectPeak(F, wav, { from: 1.2, to: 2.8 });
  ok(lv2 && lv2.peak < -80, 'a silent stretch measures as silent (' + (lv2 && lv2.peak) + ' dB)');
  const lv3 = await detectPeak(F, vid, {});
  ok(lv3 === null, 'a file without sound gives no level');
  console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
