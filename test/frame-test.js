'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const F = require('ffmpeg-static');
const DS = require('../src/shared');
const { buildExport } = require('../src/exporter');
let fail = 0; const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
console.log('Still-frame export:');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frm-'));
const src = tmp + '/a.mp4';
// red for 2 s, then blue for 2 s
spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=0x0000ff:s=320x180:r=30:d=2', '-filter_complex', '[0][1]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', src]);
const P = DS.newProject({ width: 320, height: 180, fps: 30, name: 'f' });
P.media = [{ id: 'a', path: src, name: 'a', kind: 'video', duration: 4, hasAudio: false, w: 320, h: 180 }];
P.clips = [DS.newClip({ track: 'V1', media: 'a', start: 0, in: 0, dur: 4 })];
for (const [fmt, ext, magic] of [['frame-png', 'png', [0x89, 0x50]], ['frame-jpg', 'jpg', [0xff, 0xd8]]]) {
  for (const [t, want] of [[1, 'red'], [3, 'blue']]) {
    const out = tmp + '/f' + t + '.' + ext;
    const b = buildExport(P, { outPath: out, scriptPath: tmp + '/s.txt', newFilterFlag: false, format: fmt, quality: 95, width: 320, height: 180, rangeStart: t, rangeEnd: t + 0.067 }, {});
    fs.writeFileSync(tmp + '/s.txt', b.script);
    const r = spawnSync(F, b.args, { cwd: tmp });
    const ex = fs.existsSync(out);
    ok(r.status === 0 && ex, fmt + ' at ' + t + ' s is written ' + (r.status ? String(r.stderr).slice(-200) : ''));
    if (!ex) continue;
    const buf = fs.readFileSync(out);
    ok(buf[0] === magic[0] && buf[1] === magic[1], fmt + ' has the right file signature');
    const raw = spawnSync(F, ['-v', 'error', '-i', out, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 }).stdout;
    const isRed = raw[0] > 200 && raw[2] < 60, isBlue = raw[2] > 200 && raw[0] < 60;
    ok(want === 'red' ? isRed : isBlue, fmt + ' at ' + t + ' s shows the ' + want + ' picture (' + Array.from(raw).join(',') + ')');
  }
}
process.exit(fail ? 1 : 0);
