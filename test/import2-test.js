/* OpenTimelineIO, caption formats and image sequences. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { parseOtio, importProjectFile } = require('../src/importers');
const { parseCaptions, parseSrt, parseAss, parseSbv } = require('../src/srt');
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const RT = (value, rate) => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value });
const TR = (start, dur, rate) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: RT(start, rate), duration: RT(dur, rate) });
const clip = (name, url, start, dur, rate, extra) => Object.assign({ OTIO_SCHEMA: 'Clip.2', name, source_range: TR(start, dur, rate), media_reference: url ? { OTIO_SCHEMA: 'ExternalReference.1', target_url: url } : { OTIO_SCHEMA: 'MissingReference.1' }, effects: [] }, extra || {});

console.log('OpenTimelineIO:');
{
  const tl = {
    OTIO_SCHEMA: 'Timeline.1', name: 'My cut',
    tracks: { OTIO_SCHEMA: 'Stack.1', children: [
      { OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [
        clip('A', 'file:///C:/footage/a.mov', 24, 48, 24),
        { OTIO_SCHEMA: 'Gap.1', source_range: TR(0, 12, 24) },
        clip('B', 'file:///C:/footage/b.mov', 0, 72, 24),
        { OTIO_SCHEMA: 'Transition.1', transition_type: 'SMPTE_Dissolve', in_offset: RT(6, 24), out_offset: RT(6, 24) },
        clip('C', 'file:///C:/footage/c%20x.mov', 100, 48, 24, { effects: [{ OTIO_SCHEMA: 'LinearTimeWarp.1', time_scalar: 2 }] })
      ] },
      { OTIO_SCHEMA: 'Track.1', kind: 'Audio', children: [clip('music', 'file:///C:/audio/music.wav', 0, 240, 24)] }
    ] }
  };
  const m = parseOtio(JSON.stringify(tl));
  ok(m.fps === 24 && m.name === 'My cut', 'frame rate and name are read (' + m.fps + ' fps)');
  const v = m.clips.filter((c) => c.kind === 'video');
  ok(v.length === 3, 'three video clips');
  ok(Math.abs(v[0].start) < 1e-9 && Math.abs(v[0].dur - 2) < 1e-9 && Math.abs(v[0].in - 1) < 1e-9, 'clip A: starts at 0, lasts 2 s, in-point 1 s');
  ok(Math.abs(v[1].start - 2.5) < 1e-9 && Math.abs(v[1].dur - 3) < 1e-9, 'a gap pushes the next clip 0.5 s later');
  ok(Math.abs(v[2].start - 5.5) < 1e-9 && Math.abs(v[2].speed - 2) < 1e-9 && Math.abs(v[2].dur - 1) < 1e-9, 'a 2x time warp halves the clip’s time on the timeline (' + v[2].dur + ' s)');
  ok(Math.abs(v[2].dissolve - 0.5) < 1e-9 && !v[1].dissolve, 'a dissolve transition becomes a 0.5 s dissolve into the clip after it');
  ok(v[2].file === 'C:/footage/c x.mov' || v[2].file === 'C:\\footage\\c x.mov' || /c x\.mov$/.test(v[2].file), 'file URLs are decoded (' + v[2].file + ')');
  const a = m.clips.find((c) => c.kind === 'audio');
  ok(a && a.lane === 1 && Math.abs(a.dur - 10) < 1e-9, 'the audio track is imported on A1');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-otio-'));
  const f = path.join(dir, 'x.otio'); fs.writeFileSync(f, JSON.stringify(tl));
  const r = importProjectFile(f);
  ok(r.project.clips.length === 4 && r.project.fps === 24 && r.project.clips.some((c) => c.tr && c.tr.type === 'dissolve'), 'through importProjectFile: a Ditto project with 4 clips and the dissolve');
  ok(r.warnings.some((w) => /1920/.test(w)), 'it says the picture size is assumed');
  // nested stack, missing reference, collection wrapper, junk
  const nest = JSON.parse(JSON.stringify(tl)); nest.tracks.children[0].children.splice(1, 0, { OTIO_SCHEMA: 'Stack.1', children: [{ OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [clip('in', 'file:///x.mov', 0, 24, 24)] }], source_range: TR(0, 24, 24) });
  const mn = parseOtio(JSON.stringify(nest));
  ok(mn.warnings.some((w) => /nested/.test(w)) && mn.clips.filter((c) => c.kind === 'video').length === 3, 'a nested stack is reported and skipped');
  const col = parseOtio(JSON.stringify({ OTIO_SCHEMA: 'SerializableCollection.1', children: [tl] }));
  ok(col.clips.length === 4, 'a collection holding a timeline works');
  let e1 = ''; try { parseOtio('{nope'); } catch (e) { e1 = e.message; } ok(/not a valid/.test(e1), 'broken JSON gives a clear error');
  let e2 = ''; try { parseOtio('{"OTIO_SCHEMA":"Clip.2"}'); } catch (e) { e2 = e.message; } ok(/no Timeline/.test(e2), 'a file that is not a timeline gives a clear error');
  const N = 5000, nestTxt = '{"OTIO_SCHEMA":"Timeline.1","tracks":{"OTIO_SCHEMA":"Stack.1","children":[{"OTIO_SCHEMA":"Track.1","kind":"Video","children":[' + '{"OTIO_SCHEMA":"Stack.1","children":['.repeat(N) + ']}'.repeat(N) + ']}]}}';
  let ok3 = true; try { parseOtio(nestTxt); } catch (e) { ok3 = !/call stack/i.test(e.message); }
  ok(ok3, 'a hugely nested file does not crash the importer');
  const sr = parseOtio(JSON.stringify({ OTIO_SCHEMA: 'Timeline.1', tracks: { OTIO_SCHEMA: 'Stack.1', children: [{ OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [clip('x', 'file:///x.mov', 0, 24, 24, { media_reference: { OTIO_SCHEMA: 'ImageSequenceReference.1' } })] }] } }));
  ok(sr.warnings.some((w) => /without a media file/.test(w)), 'an image-sequence reference is reported, not silently dropped');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('Caption formats:');
{
  const vtt = 'WEBVTT\n\nNOTE a comment\n\n1\n00:00:01.000 --> 00:00:03.500 align:start position:0%\n<v Dana>Hello <b>there</b> &amp; welcome\n\n00:04.000 --> 00:06.000\nSecond cue\nsecond line\n\nSTYLE\n::cue { color: red }\n';
  const c = parseCaptions(vtt, 'vtt');
  ok(c.length === 2 && c[0].start === 1 && c[0].end === 3.5 && c[0].text === 'Hello there & welcome', 'WebVTT: cues, voice and bold tags removed, entities decoded');
  ok(c[1].start === 4 && c[1].end === 6 && c[1].text === 'Second cue\nsecond line', 'WebVTT: timestamps without hours, multi-line text');
  const ass = '[Script Info]\nTitle: x\n\n[V4+ Styles]\nFormat: Name, Fontname\nStyle: Default,Arial\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:05.00,0:00:07.50,Default,,0,0,0,,{\\an8\\i1}Top, with a comma\\Nand a break\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,First\nComment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,not a cue\n';
  const a = parseCaptions(ass, 'ass');
  ok(a.length === 2 && a[0].text === 'First' && a[0].start === 1, 'ASS: dialogue lines, sorted by time, comments ignored');
  ok(a[1].text === 'Top, with a comma\nand a break' && a[1].end === 7.5, 'ASS: override tags removed, commas kept in the text, \\N is a line break');
  const sbv = '0:00:01.000,0:00:03.000\nFirst line\n\n0:00:04.500,0:00:06.000\nSecond\n';
  const s = parseCaptions(sbv, 'sbv');
  ok(s.length === 2 && s[1].start === 4.5, 'SBV cues');
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nHi &lt;you&gt;\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n';
  ok(parseCaptions(srt, 'srt').length === 2 && parseCaptions(srt, 'txt')[0].text === 'Hi <you>', 'SRT still works, also with the wrong extension');
  ok(parseCaptions(vtt, 'srt').length === 2, 'a .vtt renamed .srt is still read');
  ok(parseCaptions('garbage', 'srt').length === 0 && parseCaptions('', 'ass').length === 0, 'junk gives no cues and no crash');
  const big = Array.from({ length: 30000 }, (_, i) => (i + 1) + '\n00:00:' + String(i % 60).padStart(2, '0') + ',000 --> 00:01:00,000\nx\n').join('\n');
  ok(parseCaptions(big, 'srt').length <= 20000, 'a huge caption file is capped');
}
process.exit(failed ? 1 : 0);
