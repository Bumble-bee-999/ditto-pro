/* Premiere .prproj reader checked against a project file produced by an INDEPENDENT implementation of the format
   (the MIT-licensed @bevyl-ai/premiere-project builder, which follows the structure of files saved by Premiere Pro:
   class ids, track-group GUIDs, ObjectID / ObjectUID / ObjectRef / ObjectURef wiring, 254016000000 ticks per second).
   This is stronger than a file written by this project's own author, but it is still not a file saved by Adobe's
   application — see README ("Project import is best-effort"). Fixtures: test/fixtures/real-structure*.prproj */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { importProjectFile } = require('../src/importers');
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const near = (a, b, e) => Math.abs(a - b) < (e || 0.01);
const FX = path.join(__dirname, 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-prp-'));

console.log('Project written by an independent builder (two clips, Windows paths):');
{
  const r = importProjectFile(path.join(FX, 'real-structure.prproj'));
  const P = r.project;
  ok(P.name === 'Real Structure Cut', 'sequence name read (' + P.name + ')');
  ok(P.width === 1280 && P.height === 720 && P.fps === 25, 'frame size and rate read (' + P.width + '×' + P.height + ' @ ' + P.fps + ')');
  const c = P.clips.filter((x) => x.type === 'media').sort((a, b) => a.start - b.start);
  ok(c.length === 2, 'both clips found (' + c.length + ')');
  if (c.length === 2) {
    ok(near(c[0].start, 0) && near(c[0].dur, 4) && near(c[0].in, 10) && near(c[0].speed, 1), 'clip 1: 0–4 s, source from 10 s, normal speed');
    ok(near(c[1].start, 4) && near(c[1].dur, 2) && near(c[1].in, 0) && near(c[1].speed, 0.5), 'clip 2: 4–6 s, source 0–1 s, which is half speed');
    const m = (id) => P.media.find((x) => x.id === id);
    ok(m(c[0].media).path === 'C:\\Footage\\interview A.mp4' && m(c[1].media).path === 'D:\\B-roll\\city.mov', 'media paths come from the Media objects');
    ok(c.every((x) => x.track === 'V1'), 'clips are on V1');
  }
  ok(r.warnings.some((x) => /experimental/.test(x)), 'still flagged experimental');
}

console.log('The same file written the way Premiere writes it (declaration, tab indentation, CRLF):');
{
  const xml = zlib.gunzipSync(fs.readFileSync(path.join(FX, 'real-structure.prproj'))).toString('utf8');
  const pretty = '<?xml version="1.0" encoding="UTF-8" ?>\r\n' + xml.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/></g, '>\r\n\t<');
  const f = path.join(tmp, 'pretty.prproj'); fs.writeFileSync(f, zlib.gzipSync(Buffer.from(pretty, 'utf8')));
  const r = importProjectFile(f);
  ok(r.project.clips.filter((x) => x.type === 'media').length === 2 && r.project.fps === 25, 'whitespace between elements does not change the result');
  const raw = path.join(tmp, 'plain.prproj'); fs.writeFileSync(raw, pretty);
  ok(importProjectFile(raw).project.clips.filter((x) => x.type === 'media').length === 2, 'an uncompressed project file is read too');
}

console.log('Project with no clips (empty sequence from the same builder):');
{
  const r = importProjectFile(path.join(FX, 'real-structure-empty.prproj'));
  ok(r.project.name === 'Main' && r.project.width === 1920 && r.project.height === 1080 && near(r.project.fps, 29.97, 0.01), 'name, 1920×1080 and 29.97 fps read (' + r.project.fps.toFixed(3) + ')');
  ok(r.project.clips.length === 0 && r.warnings.some((x) => /No clips/.test(x)), 'zero clips is reported, not a crash');
}
process.exit(failed ? 1 : 0);
