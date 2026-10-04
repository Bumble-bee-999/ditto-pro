'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const F = require('ffmpeg-static');
const { spawnSync } = require('child_process');
const { parseSrt, formatSrt } = require('../src/srt');
const { findEngine, transcribe } = require('../src/whisper');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-cap-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
(async () => {
  console.log('SRT:');
  const src = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello <i>world</i>\r\n\r\n2\r\n00:01:00,250 --> 00:01:03,000\r\nSecond line\r\nwraps\r\n\r\nbroken block\r\n';
  const cues = parseSrt(src);
  ok(cues.length === 2 && cues[0].start === 1 && cues[0].end === 2.5 && cues[0].text === 'Hello world', 'parses timings and strips tags / BOM / CRLF');
  ok(cues[1].start === 60.25 && cues[1].text === 'Second line\nwraps', 'multi-line cue and minutes');
  const back = parseSrt(formatSrt(cues));
  ok(back.length === 2 && back[1].start === 60.25 && back[1].end === 63, 'format → parse round trip');

  console.log('Engine discovery:');
  const d = path.join(tmp, 'whisper', 'Release'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'whisper-cli.exe'), ''); fs.writeFileSync(path.join(tmp, 'whisper', 'ggml-base.en.bin'), ''); fs.writeFileSync(path.join(tmp, 'whisper', 'ggml-tiny.bin'), '');
  const e = findEngine([path.join(tmp, 'whisper')], {});
  ok(/whisper-cli\.exe$/.test(e.bin) && /ggml-base\.en\.bin$/.test(e.model), 'finds nested whisper-cli.exe and prefers the better model');
  ok(!findEngine([path.join(tmp, 'nothing')], {}).bin, 'reports a missing engine');

  console.log('Transcription plumbing (stand-in engine that writes a known SRT):');
  const wav = path.join(tmp, 'a.wav');
  spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=10', wav]);
  const fake = path.join(tmp, 'fake-whisper.sh');
  fs.writeFileSync(fake, '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then OF="$2"; fi; if [ "$1" = "-f" ]; then IN="$2"; fi; shift; done\n[ -s "$IN" ] || exit 3\nprintf "1\\n00:00:00,500 --> 00:00:01,500\\nhello there\\n\\n2\\n00:00:02,000 --> 00:00:03,000\\n[BLANK_AUDIO]\\n\\n" > "$OF.srt"\n');
  fs.chmodSync(fake, 0o755);
  const model = path.join(tmp, 'ggml-x.bin'); fs.writeFileSync(model, '');
  const out = await transcribe(F, { bin: fake, model }, wav, { from: 4, to: 8 });
  ok(out.length === 1 && out[0].text === 'hello there' && Math.abs(out[0].start - 4.5) < 1e-6 && Math.abs(out[0].end - 5.5) < 1e-6, 'cue times are shifted by the clip start; noise markers dropped');
  ok(out[0].words && out[0].words.length === 2 && out[0].words[0].text === 'hello' && Math.abs(out[0].words[1].end - 5.5) < 1e-6, 'every cue carries per-word timings');
  const { toWords, groupWords } = require('../src/whisper');
  const w = toWords([{ start: 0, end: 0.4, text: ' So' }, { start: 0.4, end: 0.9, text: ' we' }, { start: 0.9, end: 1.5, text: ' begin' }, { start: 1.5, end: 1.6, text: '.' }, { start: 1.6, end: 2.0, text: '[BLANK_AUDIO]' }, { start: 3.5, end: 4, text: ' Next' }, { start: 4, end: 4.5, text: '(music)' }, { start: 4.5, end: 5, text: ' one' }]);
  ok(w.map((x) => x.text).join('|') === 'So|we|begin.|Next|one', 'words: punctuation joins the word before it, noise markers are dropped');
  const g = groupWords(w);
  ok(g.length === 2 && g[0].text === 'So we begin.' && g[1].text === 'Next one' && g[1].start === 3.5, 'lines break at pauses; cue times come from the words');
  const long = groupWords(Array.from({ length: 30 }, (_, i) => ({ start: i * 0.3, end: i * 0.3 + 0.25, text: 'word' + i })), { maxChars: 42 });
  ok(long.length > 3 && long.every((c) => c.text.length <= 43), 'long speech is wrapped to about 42 characters per line');
  let msg = ''; try { await transcribe(F, { bin: null, model: null }, wav, {}); } catch (err) { msg = err.message; }
  ok(/not installed/.test(msg), 'clear error when the engine is missing');

  if (process.env.DITTO_WHISPER_BIN && process.env.DITTO_WHISPER_MODEL) {
    console.log('Real whisper.cpp binary (test model; checks the command line works, not accuracy):');
    const r = await transcribe(F, { bin: process.env.DITTO_WHISPER_BIN, model: process.env.DITTO_WHISPER_MODEL }, wav, { from: 0, to: 3 });
    ok(Array.isArray(r), 'whisper-cli ran with our arguments and produced a readable .srt');
  }
  console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
