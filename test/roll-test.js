'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const F = require('ffmpeg-static');
const DS = require('../src/shared');
const { buildExport } = require('../src/exporter');
let fail = 0; const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
console.log('Rolling credits:');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-'));
const W = 320, H = 180, TH = 540;
// a "title" three frames tall: white band along its top edge, red band along its bottom edge
const png = path.join(tmp, 'title.png');
spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black@0:s=' + W + 'x' + TH + ',format=rgba,drawbox=x=0:y=0:w=' + W + ':h=20:color=white:t=fill:replace=1,drawbox=x=0:y=' + (TH - 20) + ':w=' + W + ':h=20:color=red:t=fill:replace=1', '-frames:v', '1', png]);
ok(DS.titleHeight({ roll: false, text: 'a\nb', size: 96 }, 180) === 180, 'a normal title is one frame tall');
const th = DS.titleHeight({ roll: true, text: new Array(20).fill('line').join('\n'), size: 40, lineH: 1.5 }, 180);
ok(th === 1240, 'a rolling title is as tall as its text (' + th + ' px for 20 lines of 40 px at 1.5 spacing)');
ok(DS.titleHeight({ roll: true, text: 'x', size: 20 }, 180) === 180 && DS.titleHeight({ roll: true, text: new Array(5000).fill('x').join('\n'), size: 96 }, 180) === DS.ROLL_MAX_H, 'never shorter than the frame, capped at ' + DS.ROLL_MAX_H + ' px');
ok(DS.rollOffset(H, TH, 0, 4) === 360 && DS.rollOffset(H, TH, 4, 4) === -360 && DS.rollOffset(H, TH, 2, 4) === 0 && DS.rollOffset(H, TH, 99, 4) === -360, 'starts just below the frame, ends just above it');
function render(setup) {
  const P = DS.newProject({ width: W, height: H, fps: 30, name: 'r' });
  const c = DS.newClip({ track: 'V1', type: 'title', start: 1, dur: 4 });
  c.title = DS.newTitle('x'); c.title.roll = true;
  if (setup) setup(c);
  P.clips = [c];
  const out = path.join(tmp, 'o' + Math.random().toString(36).slice(2) + '.mp4');
  const b = buildExport(P, { outPath: out, scriptPath: path.join(tmp, 's.txt'), newFilterFlag: false, format: 'mp4-h264', quality: 100 }, { titleFiles: { [c.id]: png }, titleSizes: { [c.id]: { w: W, h: TH } } });
  fs.writeFileSync(path.join(tmp, 's.txt'), b.script);
  const r = spawnSync(F, b.args, { cwd: tmp });
  return { code: r.status, err: String(r.stderr).slice(-300), out };
}
const frame = (out, n) => spawnSync(F, ['-v', 'error', '-i', out, '-vf', 'select=eq(n\\,' + n + ')', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 }).stdout;
const px = (buf, x, y) => [buf[(y * W + x) * 3], buf[(y * W + x) * 3 + 1], buf[(y * W + x) * 3 + 2]];
const white = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200, red = (p) => p[0] > 180 && p[1] < 70 && p[2] < 70, black = (p) => p[0] < 30 && p[1] < 30 && p[2] < 30;
// rowOf(lt): where the title's top edge is in the frame = 180 - 180 * lt
const r = render();
ok(r.code === 0, 'a rolling title exports ' + (r.code ? r.err : ''));
if (r.code === 0) {
  let f = frame(r.out, 30 + 1);            // one frame in: the top edge is at row 174, everything above is still empty
  ok(black(px(f, 160, 90)) && black(px(f, 160, 165)) && white(px(f, 160, 178)), 'at the start the text is only just entering at the bottom');
  f = frame(r.out, 30 + 15);               // lt = 0.5: top edge at row 90, so the white band covers rows 90..110
  ok(white(px(f, 160, 100)) && black(px(f, 160, 80)) && black(px(f, 160, 125)), 'half a second in, the top of the text is half-way up (row 100 ' + px(f, 160, 100).join(',') + ')');
  f = frame(r.out, 30 + 30);               // lt = 1: top edge at row 0
  ok(white(px(f, 160, 9)) && black(px(f, 160, 40)), 'after one second the top of the text reaches the top of the frame');
  f = frame(r.out, 30 + 105);              // lt = 3.5: top edge at -450, the red band (520..540) is at rows 70..90
  ok(red(px(f, 160, 80)) && black(px(f, 160, 60)) && black(px(f, 160, 100)), 'near the end the last line is passing through (row 80 ' + px(f, 160, 80).join(',') + ')');
  f = frame(r.out, 30 + 119);              // last frame: only the very end of the red band may remain at the top
  ok(black(px(f, 160, 30)) && black(px(f, 160, 150)), 'at the end the text has left the frame');
}
const r2 = render((c) => { c.kf.opacity = [{ t: 0, v: 0, e: 'lin' }, { t: 1, v: 100, e: 'lin' }]; });
if (r2.code === 0) { const f = frame(r2.out, 30 + 15); const p = px(f, 160, 100); ok(p[0] > 90 && p[0] < 165, 'keyframed opacity works on a rolling title (half-faded white: ' + p.join(',') + ')'); } else ok(false, 'rolling title with keyframed opacity exports: ' + r2.err);
const r3 = render((c) => { c.title.roll = false; });
ok(r3.code === 0 && (() => { const f = frame(r3.out, 30 + 60); return white(px(f, 160, 3)) && red(px(f, 160, 176)); })(), 'with rolling off the same picture is simply fitted to the frame');
process.exit(fail ? 1 : 0);
