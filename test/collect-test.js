'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { collectProject, findBeside, filesOf } = require('../src/collect');
let fail = 0; const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
(async () => {
  console.log('Collect project files:');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-'));
  const a = path.join(tmp, 'src1'), b = path.join(tmp, 'src2'), dest = path.join(tmp, 'out');
  [a, b, dest].forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(a, 'shot.mp4'), 'AAAA'); fs.writeFileSync(path.join(b, 'shot.mp4'), 'BBBBBB');   // same name, two folders
  fs.writeFileSync(path.join(a, 'music.wav'), 'MM'); fs.writeFileSync(path.join(a, 'look.cube'), 'LUT');
  const proj = {
    app: 'ditto-pro', name: 'My: Film?', width: 1920, height: 1080, fps: 30, tracks: [],
    media: [{ id: 'm1', path: path.join(a, 'shot.mp4') }, { id: 'm2', path: path.join(b, 'shot.mp4') }, { id: 'm3', path: path.join(a, 'music.wav') }, { id: 'm4', path: path.join(a, 'gone.mov') }, { id: 'n1', path: '', nest: 'nestA' }],
    clips: [{ id: 'c1', media: 'm1', fx: { lut: { path: path.join(a, 'look.cube') } } }],
    nests: { nestA: { clips: [{ id: 'c2', media: 'm2', fx: { lut: { path: path.join(a, 'look.cube') } } }] } }
  };
  ok(filesOf(proj).length === 5, 'lists each media file and LUT once (nested sequences included, nest renders left out)');
  const seen = [];
  const r = await collectProject(proj, dest, { onProgress: (p) => seen.push(p.done + '/' + p.total) });
  ok(path.basename(r.dir) === 'My_ Film_ (collected)' && fs.existsSync(r.project), 'makes a folder named after the project (unsafe characters replaced): ' + path.basename(r.dir));
  const got = fs.readdirSync(path.join(r.dir, 'Media')).sort();
  ok(got.join('|') === 'look.cube|music.wav|shot (2).mp4|shot.mp4', 'copies the files, renaming a clash (' + got.join(', ') + ')');
  ok(fs.readFileSync(path.join(r.dir, 'Media', 'shot.mp4'), 'utf8') === 'AAAA' && fs.readFileSync(path.join(r.dir, 'Media', 'shot (2).mp4'), 'utf8') === 'BBBBBB', 'each copy has the right content');
  ok(r.copied === 4 && r.bytes === 15 && r.skipped.length === 1 && r.skipped[0] === 'gone.mov', 'reports what was copied and what was missing');
  const out = JSON.parse(fs.readFileSync(r.project, 'utf8'));
  const inMedia = (p) => path.dirname(p) === path.join(r.dir, 'Media');
  ok(inMedia(out.media[0].path) && inMedia(out.media[1].path) && out.media[0].path !== out.media[1].path && inMedia(out.clips[0].fx.lut.path) && inMedia(out.nests.nestA.clips[0].fx.lut.path), 'the collected project points at the copies (also inside nested sequences)');
  ok(out.media[3].path === path.join(a, 'gone.mov') && out.media[4].nest === 'nestA', 'missing files and nests keep their entry');
  ok(proj.media[0].path === path.join(a, 'shot.mp4'), 'the open project itself is not changed');
  ok(seen[0] === '0/5' && seen[seen.length - 1] === '5/5', 'progress runs from 0 to the end');
  const r2 = await collectProject(proj, dest, {});
  ok(path.basename(r2.dir) === 'My_ Film_ (collected 2)', 'a second collection goes to a new folder');
  // moved to another computer: paths are stale, the files sit beside the project
  const moved = path.join(tmp, 'elsewhere'); fs.renameSync(r.dir, moved);
  const stale = out.media.slice(0, 3).map((m) => m.path).concat(['C:\\Users\\someone\\Videos\\music.wav', '/nope/absent.mp4', '..']);
  const f = findBeside(path.join(moved, 'My_ Film_.dpro'), stale);
  ok(f[stale[0]] === path.join(moved, 'Media', 'shot.mp4') && f[stale[3]] === path.join(moved, 'Media', 'music.wav') && !f['/nope/absent.mp4'] && !f['..'], 'files are found again beside a moved project (Windows-style paths too)');
  ok(Object.keys(findBeside(null, stale)).length === 0, 'no project path, nothing is guessed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
