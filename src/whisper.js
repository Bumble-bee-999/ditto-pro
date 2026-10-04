'use strict';
/*
 * Ditto Pro — offline speech-to-text through whisper.cpp (https://github.com/ggml-org/whisper.cpp).
 * The engine (whisper-cli) and a ggml model are bundled with the installer by the build scripts; nothing is uploaded.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseSrt } = require('./srt');

function walk(dir, depth, out) {
  if (depth < 0) return out;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth - 1, out); else out.push(p);
  }
  return out;
}

/** Looks for the engine + model in the given folders (resources/whisper, user data/whisper) or DITTO_WHISPER_BIN / DITTO_WHISPER_MODEL. */
function findEngine(dirs, env) {
  env = env || process.env;
  let bin = env.DITTO_WHISPER_BIN && fs.existsSync(env.DITTO_WHISPER_BIN) ? env.DITTO_WHISPER_BIN : null;
  let model = env.DITTO_WHISPER_MODEL && fs.existsSync(env.DITTO_WHISPER_MODEL) ? env.DITTO_WHISPER_MODEL : null;
  for (const d of dirs || []) {
    if (bin && model) break;
    const files = walk(d, 3, []);
    if (!bin) bin = files.find((f) => /(^|[\\/])(whisper-cli|main)(\.exe)?$/i.test(f)) || null;
    if (!model) {
      const models = files.filter((f) => /ggml-.*\.bin$/i.test(path.basename(f)) && !/for-tests/i.test(f));
      // prefer bigger / better models when several are present, but skip huge ones by default
      const rank = (f) => (/large/i.test(f) ? 5 : /medium/i.test(f) ? 4 : /small/i.test(f) ? 3 : /base/i.test(f) ? 2 : 1);
      models.sort((a, b) => rank(b) - rank(a));
      model = models[0] || null;
    }
  }
  return { bin, model };
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, Object.assign({ windowsHide: true }, opts));
    let err = '';
    p.stderr && p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 2e6) err = err.slice(-1e6); });
    p.stdout && p.stdout.on('data', () => {});
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.slice(-500) || (cmd + ' exited with code ' + code)))));
  });
}

const NOISE_OPEN = /^[\[(]/, NOISE_CLOSE = /[\])]$/;
/** SRT cues (one per word, or per phrase) -> word list with times. Phrases are split in proportion to word length. */
function toWords(cues) {
  const words = [];
  let skipping = false;
  for (const c of cues) {
    const toks = String(c.text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const keep = [];
    for (const t of toks) {
      if (skipping) { if (NOISE_CLOSE.test(t)) skipping = false; continue; }
      if (NOISE_OPEN.test(t)) { if (!NOISE_CLOSE.test(t)) skipping = true; continue; } // [BLANK_AUDIO], (music), [ Silence ]
      keep.push(t);
    }
    if (!keep.length) continue;
    const total = keep.reduce((a, t) => a + t.length, 0) || 1;
    let at = c.start;
    for (const t of keep) {
      const d = (c.end - c.start) * t.length / total;
      if (/^[.,!?;:…]+$/.test(t) && words.length) { words[words.length - 1].text += t; words[words.length - 1].end = at + d; }
      else words.push({ start: at, end: at + d, text: t });
      at += d;
    }
  }
  return words;
}
/** Words -> caption lines (about 42 characters, broken at sentence ends and pauses). Each cue keeps its word timings. */
function groupWords(words, o) {
  o = o || {};
  const maxChars = o.maxChars || 42, maxGap = o.maxGap || 0.7, maxDur = o.maxDur || 7;
  const cues = []; let cur = null;
  const flush = () => { if (cur) { cur.text = cur.words.map((w) => w.text).join(' '); cur.start = cur.words[0].start; cur.end = cur.words[cur.words.length - 1].end; cues.push(cur); cur = null; } };
  for (const w of words) {
    if (cur) {
      const last = cur.words[cur.words.length - 1];
      const len = cur.words.reduce((a, x) => a + x.text.length + 1, 0);
      const sentenceEnd = /[.?!…]$/.test(last.text) && len >= 16;
      if (sentenceEnd || len + w.text.length > maxChars || w.start - last.end > maxGap || w.end - cur.words[0].start > maxDur) flush();
    }
    if (!cur) cur = { words: [] };
    cur.words.push(w);
  }
  flush();
  return cues;
}

/**
 * Transcribe part of a media file. Returns cues in the file's own time (seconds): [{ start, end, text }]
 */
async function transcribe(ffmpeg, engine, file, o) {
  o = o || {};
  if (!engine || !engine.bin || !engine.model) throw new Error('The speech engine is not installed. Rebuild the installer with the bundled whisper engine (see README → Captions), or set DITTO_WHISPER_BIN and DITTO_WHISPER_MODEL.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dittowhisper-'));
  try {
    const wav = path.join(tmp, 'audio.wav');
    const a = ['-y', '-v', 'error', '-nostdin'];
    if (o.from != null) a.push('-ss', String(o.from));
    a.push('-i', file);
    if (o.to != null && o.from != null) a.push('-t', String(Math.max(0.1, o.to - o.from)));
    a.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav);
    await run(ffmpeg, a);
    const outBase = path.join(tmp, 'out');
    const args = ['-m', engine.model, '-f', wav, '-osrt', '-of', outBase, '-ml', '1', '-sow', '-np']; // one word per entry: exact word timings, regrouped into lines below
    if (o.language && o.language !== 'auto') args.push('-l', o.language); else if (/\.en\./i.test(engine.model)) args.push('-l', 'en'); else args.push('-l', 'auto');
    if (o.threads) args.push('-t', String(o.threads));
    await run(engine.bin, args, { cwd: path.dirname(engine.bin) });
    const srt = fs.readFileSync(outBase + '.srt', 'utf8');
    const off = o.from || 0;
    const words = toWords(parseSrt(srt).map((c) => ({ start: c.start + off, end: c.end + off, text: c.text })));
    return groupWords(words, o);
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
}

module.exports = { findEngine, transcribe, toWords, groupWords };
