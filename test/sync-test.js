'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const F = require('ffmpeg-static');
const { syncFiles } = require('../src/sync');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-sync-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const sh = (a) => { const r = spawnSync(F, a, { encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); };
(async () => {
  console.log('Multicam audio sync:');
  // a "scene": band-limited noise with a few clicks, 25 s
  const base = path.join(tmp, 'scene.wav');
  sh(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=25:c=pink:r=44100:a=0.5:seed=7', '-af', 'volume=1', base]);
  // camera A = the scene; camera B starts 1.37 s earlier (so its content is delayed by 1.37 s), quieter, plus its own noise
  const A = path.join(tmp, 'camA.wav'), B = path.join(tmp, 'camB.wav'), C = path.join(tmp, 'camC.wav');
  sh(['-y', '-v', 'error', '-i', base, '-ac', '1', A]);
  sh(['-y', '-v', 'error', '-i', base, '-af', 'adelay=1370:all=1,volume=0.4', '-ac', '1', B]);
  sh(['-y', '-v', 'error', '-i', base, '-af', 'atrim=start=2.5,asetpts=PTS-STARTPTS,volume=1.5', '-ac', '1', C]); // started 2.5 s later
  const r = await syncFiles(F, [{ file: A }, { file: B }, { file: C }], {});
  ok(Math.abs(r[1].lag - 1.37) < 0.01, 'camera B found 1.370 s behind A (got ' + r[1].lag.toFixed(3) + ')');
  ok(Math.abs(r[2].lag - (-2.5)) < 0.01, 'camera C found 2.500 s ahead of A (got ' + r[2].lag.toFixed(3) + ')');
  ok(r[1].confidence > 8 && r[2].confidence > 8, 'clear correlation peak (confidence ' + r[1].confidence.toFixed(0) + ', ' + r[2].confidence.toFixed(0) + ')');
  console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
