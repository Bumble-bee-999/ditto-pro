'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { importProjectFile, tcToSeconds, fileUrlToPath, TICKS_PER_SECOND } = require('../src/importers');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-imp-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const near = (a, b, e) => Math.abs(a - b) <= (e || 0.01);
const w = (n, s) => { const p = path.join(tmp, n); fs.writeFileSync(p, s); return p; };

console.log('Timecode + paths:');
ok(near(tcToSeconds('00:00:10:15', 30), 10.5), 'non-drop 10:15 @30 = 10.5 s');
ok(near(tcToSeconds('00:10:00;00', 29.97), 17982 / 29.97, 0.001), 'drop-frame 10:00;00 @29.97 skips 18 frames per 10 min');
ok(fileUrlToPath('file://localhost/C%3a/Users/me/My%20clip.mov') === 'C:/Users/me/My clip.mov', 'file URL -> Windows path');

console.log('EDL (CMX 3600):');
{
  const edl = `TITLE: Demo cut
FCM: NON-DROP FRAME

001  A001     V     C        00:00:05:00 00:00:08:00 01:00:00:00 01:00:03:00
* FROM CLIP NAME: interview.mov
* SOURCE FILE: C:\\Footage\\interview.mov
001  A001     AA    C        00:00:05:00 00:00:08:00 01:00:00:00 01:00:03:00
* FROM CLIP NAME: interview.mov
002  A002     V     C        00:00:00:00 00:00:02:00 01:00:03:00 01:00:05:00
* FROM CLIP NAME: broll.mp4
003  A003     V     D    030 00:00:10:00 00:00:14:00 01:00:05:00 01:00:09:00
* FROM CLIP NAME: sky.mp4
`;
  const r = importProjectFile(w('demo.edl', edl), { fps: 30 });
  const P = r.project;
  const v = P.clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start);
  ok(P.name === 'Demo cut' || P.name === 'demo', 'project named');
  ok(v.length === 3 && near(v[0].start, 0) && near(v[0].dur, 3) && near(v[0].in, 5), 'first event: start 0, dur 3 s, source in 5 s');
  ok(near(v[1].start, 3) && near(v[2].start, 5) && near(v[2].dur, 4), 'later events placed back to back');
  ok(v[2].tr && v[2].tr.type === 'dissolve' && near(v[2].tr.dur, 1), 'dissolve (D 030) becomes a 1 s dissolve');
  ok(P.clips.every((c) => c.track !== 'A1'), 'audio that mirrors the video clip is not duplicated');
  ok(P.media.find((m) => m.name === 'interview.mov').path === 'C:\\Footage\\interview.mov', 'source file path from the EDL comment is kept');
  ok(r.warnings.some((x) => /offline/.test(x)), 'warns that media may need relinking');
}

console.log('Final Cut Pro XML (xmeml, as exported by Premiere):');
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="4"><sequence id="seq1"><name>Premiere Seq</name><duration>300</duration>
<rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
<media><video><format><samplecharacteristics><width>1280</width><height>720</height></samplecharacteristics></format>
<track>
<clipitem id="ci1"><name>A.mp4</name><enabled>TRUE</enabled><start>0</start><end>90</end><in>30</in><out>120</out>
 <file id="f1"><name>A.mp4</name><pathurl>file://localhost/C%3a/media/A.mp4</pathurl></file></clipitem>
<clipitem id="ci2"><name>B.mp4</name><enabled>TRUE</enabled><start>90</start><end>180</end><in>0</in><out>90</out>
 <file id="f2"><name>B.mp4</name><pathurl>file://localhost/C%3a/media/B.mp4</pathurl></file></clipitem>
</track>
<track><clipitem id="ci3"><name>logo.png</name><enabled>TRUE</enabled><start>30</start><end>150</end><in>0</in><out>120</out>
 <file id="f3"><name>logo.png</name><pathurl>file://localhost/C%3a/media/logo.png</pathurl></file></clipitem></track>
</video>
<audio><track>
<clipitem id="ci4"><name>A.mp4</name><enabled>TRUE</enabled><start>0</start><end>90</end><in>30</in><out>120</out><file id="f1"/></clipitem>
</track><track>
<clipitem id="ci5"><name>A.mp4</name><enabled>TRUE</enabled><start>0</start><end>90</end><in>30</in><out>120</out><file id="f1"/></clipitem>
</track>
<track><clipitem id="ci6"><name>music.wav</name><enabled>TRUE</enabled><start>0</start><end>300</end><in>0</in><out>300</out>
 <file id="f4"><name>music.wav</name><pathurl>file://localhost/C%3a/media/music.wav</pathurl></file></clipitem></track>
</audio></media></sequence></xmeml>`;
  const r = importProjectFile(w('seq.xml', xml));
  const P = r.project;
  ok(P.width === 1280 && P.height === 720 && P.fps === 30, 'sequence settings 1280x720 @ 30');
  const a = P.clips.find((c) => P.media.find((m) => m.id === c.media).name === 'A.mp4' && c.track === 'V1');
  ok(a && near(a.start, 0) && near(a.dur, 3) && near(a.in, 1), 'clip A: 3 s long, source in 1 s');
  const logo = P.clips.find((c) => P.media.find((m) => m.id === c.media).name === 'logo.png');
  ok(logo && logo.track === 'V2' && near(logo.start, 1), 'second video track becomes V2');
  ok(P.clips.filter((c) => c.track.startsWith('A') && P.media.find((m) => m.id === c.media).name === 'A.mp4').length === 0, 'linked / duplicate mono audio of A.mp4 is not duplicated');
  const mus = P.clips.find((c) => P.media.find((m) => m.id === c.media).name === 'music.wav');
  ok(mus && mus.track.startsWith('A') && near(mus.dur, 10), 'standalone music clip on an audio track');
  ok(P.media.find((m) => m.name === 'A.mp4').path === 'C:/media/A.mp4', 'media path decoded');
}

console.log('FCPXML 1.9:');
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.9"><resources>
<format id="r1" name="FFVideoFormat1080p25" frameDuration="100/2500s" width="1920" height="1080"/>
<asset id="r2" name="clipA" start="0s" duration="20s" hasVideo="1" hasAudio="1" format="r1"><media-rep kind="original-media" src="file:///C:/Footage/clipA.mov"/></asset>
<asset id="r3" name="clipB" start="3600s" duration="30s" hasVideo="1" hasAudio="1" format="r1"><media-rep kind="original-media" src="file:///C:/Footage/clipB.mov"/></asset>
<asset id="r4" name="vo" start="0s" duration="30s" hasVideo="0" hasAudio="1"><media-rep kind="original-media" src="file:///C:/Footage/vo.wav"/></asset>
</resources><library><event name="E"><project name="My FCPX"><sequence format="r1" tcStart="3600s" duration="10s">
<spine>
<asset-clip ref="r2" offset="3600s" name="clipA" start="2s" duration="4s">
  <asset-clip ref="r4" lane="-1" offset="4s" name="vo" start="0s" duration="3s"/>
</asset-clip>
<gap offset="3604s" duration="1s"/>
<asset-clip ref="r3" offset="3605s" name="clipB" start="3601s" duration="5s"/>
</spine></sequence></project></event></library></fcpxml>`;
  const r = importProjectFile(w('p.fcpxml', xml));
  const P = r.project;
  ok(near(P.fps, 25) && P.width === 1920, 'fps 25 from frameDuration 100/2500s');
  const A1 = P.clips.find((c) => P.media.find((m) => m.id === c.media).name === 'clipA.mov');
  ok(A1 && A1.track === 'V1' && near(A1.start, 0) && near(A1.in, 2) && near(A1.dur, 4), 'clipA at 0, source in 2 s, 4 s long (tcStart removed)');
  const B1 = P.clips.find((c) => P.media.find((m) => m.id === c.media).name === 'clipB.mov');
  ok(B1 && near(B1.start, 5) && near(B1.in, 1) && near(B1.dur, 5), 'clipB at 5 s; source in measured from the asset start (3601 - 3600)');
  const vo = P.clips.find((c) => P.media.find((m) => m.id === c.media).name === 'vo.wav');
  ok(vo && vo.track === 'A1' && near(vo.start, 2) && near(vo.dur, 3), 'connected audio on lane -1 -> A1 at 2 s');
}

console.log('Premiere .prproj (experimental, synthetic file in the documented structure):');
{
  const T = (s) => Math.round(s * TICKS_PER_SECOND);
  const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<PremiereData Version="3">
<Project ObjectID="1" ClassID="62ad66dd-0dcd-42da-a660-6d8fbde94876" Version="1"/>
<Media ObjectUID="m-uid-1" ClassID="x" Version="1"><FilePath>C:\\Footage\\one.mp4</FilePath><ActualMediaFilePath>C:\\Footage\\one.mp4</ActualMediaFilePath><Title>one.mp4</Title></Media>
<Media ObjectUID="m-uid-2" ClassID="x" Version="1"><FilePath>C:\\Footage\\two.mp4</FilePath><Title>two.mp4</Title></Media>
<VideoMediaSource ObjectID="20"><MediaSource><Media ObjectURef="m-uid-1"/></MediaSource></VideoMediaSource>
<VideoMediaSource ObjectID="21"><MediaSource><Media ObjectURef="m-uid-2"/></MediaSource></VideoMediaSource>
<VideoClip ObjectID="30"><Clip><InPoint>${T(2)}</InPoint><OutPoint>${T(5)}</OutPoint><Source ObjectRef="20"/></Clip></VideoClip>
<VideoClip ObjectID="31"><Clip><InPoint>0</InPoint><OutPoint>${T(4)}</OutPoint><Source ObjectRef="21"/></Clip></VideoClip>
<SubClip ObjectID="40"><Name>one.mp4</Name><Clip ObjectRef="30"/></SubClip>
<SubClip ObjectID="41"><Name>two.mp4</Name><Clip ObjectRef="31"/></SubClip>
<VideoClipTrackItem ObjectID="50"><ClipTrackItem><TrackItem><Start>0</Start><End>${T(3)}</End></TrackItem><SubClip ObjectRef="40"/></ClipTrackItem></VideoClipTrackItem>
<VideoClipTrackItem ObjectID="51"><ClipTrackItem><TrackItem><Start>${T(3)}</Start><End>${T(7)}</End></TrackItem><SubClip ObjectRef="41"/></ClipTrackItem></VideoClipTrackItem>
<VideoClipTrack ObjectUID="trk-uid-1"><ClipTrack><ClipItems><TrackItems><TrackItem Index="0" ObjectRef="50"/><TrackItem Index="1" ObjectRef="51"/></TrackItems></ClipItems></ClipTrack></VideoClipTrack>
<VideoTrackGroup ObjectID="60"><TrackGroup><Tracks Version="1"><Track Index="0" ObjectURef="trk-uid-1"/></Tracks></TrackGroup><FrameRect>0,0,1280,720</FrameRect><FrameRate>${Math.round(TICKS_PER_SECOND / 25)}</FrameRate></VideoTrackGroup>
<Sequence ObjectUID="seq-uid-1" ClassID="y" Version="1"><Name>Main Edit</Name><TrackGroups><TrackGroup Version="1"><First>228cda18-3625-4d2d-951e-348879e4ed93</First><Second ObjectRef="60"/></TrackGroup></TrackGroups></Sequence>
</PremiereData>`;
  const gz = path.join(tmp, 'edit.prproj'); fs.writeFileSync(gz, zlib.gzipSync(Buffer.from(xml, 'utf8')));
  const r = importProjectFile(gz);
  const P = r.project;
  ok(P.name === 'Main Edit' || P.name === 'edit', 'sequence name read');
  ok(near(P.fps, 25) && P.width === 1280 && P.height === 720, 'frame rate 25 and size 1280x720 read from the track group');
  const c = P.clips.sort((a, b) => a.start - b.start);
  ok(c.length === 2 && near(c[0].start, 0) && near(c[0].dur, 3) && near(c[0].in, 2), 'first clip: 0–3 s, source in 2 s');
  ok(near(c[1].start, 3) && near(c[1].dur, 4), 'second clip: 3–7 s');
  ok(P.media.find((m) => m.name === 'one.mp4').path === 'C:\\Footage\\one.mp4', 'media path read from the Media object');
  ok(r.warnings.some((x) => /experimental/.test(x)), 'flags the importer as experimental');
  let bad = false; try { importProjectFile(w('junk.prproj', 'not xml')); } catch (e) { bad = /Premiere/.test(e.message); }
  ok(bad, 'rejects a file that is not a Premiere project');
}

console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
