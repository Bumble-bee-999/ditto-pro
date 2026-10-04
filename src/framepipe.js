'use strict';
/*
 * Ditto Pro — frame pipe: decode a video segment to raw frames, hand each one to JavaScript, and (optionally) encode the
 * processed frames. This is how the stabiliser, tracker and background remover get at the pixels, offline and with
 * back-pressure (a slow processing step never makes FFmpeg buffer the whole clip in memory).
 */
const { spawn } = require('child_process');

function errTail(s) { return String(s).split('\n').filter(Boolean).slice(-5).join('\n'); }

/**
 * Calls `onFrame(Buffer, index)` (may be async) for every frame.
 * o: { file, from, span, fps, w, h, pix: 'gray'|'rgb24'|'rgba', filter }
 */
async function decodeFrames(ffmpeg, o, onFrame, isCancelled) {
  const pix = o.pix || 'rgb24', bpp = pix === 'gray' ? 1 : pix === 'rgba' ? 4 : 3;
  const size = o.w * o.h * bpp;
  const vf = ['fps=' + (o.fps || 30), 'scale=' + o.w + ':' + o.h + ':flags=' + (o.scaleFlags || 'area')].concat(o.filter ? [o.filter] : []).join(',');
  const args = ['-v', 'error', '-nostdin'];
  if (o.from) args.push('-ss', String(o.from));
  if (o.span) args.push('-t', String(o.span));
  args.push('-i', o.file, '-an', '-vf', vf, '-pix_fmt', pix, '-f', 'rawvideo', '-');
  const p = spawn(ffmpeg, args, { windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 1e6) err = err.slice(-5e5); });
  const exited = new Promise((resolve) => p.on('close', resolve));
  let chunks = [], have = 0, idx = 0, cancelled = false;
  try {
    for await (const chunk of p.stdout) {
      chunks.push(chunk); have += chunk.length;
      while (have >= size) {
        const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, have);
        const frame = all.subarray(0, size);
        const rest = all.subarray(size);
        chunks = rest.length ? [rest] : []; have = rest.length;
        await onFrame(Buffer.from(frame), idx++);
        if (isCancelled && isCancelled()) { cancelled = true; break; }
      }
      if (cancelled) break;
    }
  } finally { if (cancelled) p.kill(); }
  const code = await exited;
  if (cancelled) throw new Error('Cancelled.');
  if (code !== 0 && idx === 0) throw new Error('Could not read the video: ' + errTail(err));
  return idx;
}

/** Raw-frame encoder. o: { w, h, fps, pix, out, audio:{file,from,span}|null, vcodecArgs } */
function startEncoder(ffmpeg, o) {
  const pix = o.pix || 'rgb24';
  const args = ['-y', '-v', 'error', '-nostdin', '-f', 'rawvideo', '-pix_fmt', pix, '-s', o.w + 'x' + o.h, '-r', String(o.fps), '-i', '-'];
  if (o.audio) args.push('-ss', String(o.audio.from || 0), '-t', String(o.audio.span), '-i', o.audio.file);
  args.push('-map', '0:v:0');
  if (o.audio) args.push('-map', '1:a:0?');
  args.push.apply(args, o.vcodecArgs || ['-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p']);
  if (o.audio) args.push('-c:a', 'aac', '-b:a', '256k', '-shortest');
  args.push(o.out);
  const p = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '', dead = false, failure = null;
  p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 1e6) err = err.slice(-5e5); });
  p.stdin.on('error', (e) => { dead = true; failure = e; });
  const closed = new Promise((resolve) => p.on('close', (code) => { dead = true; resolve(code); }));
  return {
    async write(buf) {
      if (dead) throw new Error('The encoder stopped: ' + errTail(err));
      if (!p.stdin.write(buf)) {
        await new Promise((resolve) => {
          const done = () => { p.stdin.off('drain', done); p.stdin.off('error', done); p.stdin.off('close', done); resolve(); };
          p.stdin.on('drain', done); p.stdin.on('error', done); p.stdin.on('close', done);
        });
      }
    },
    async end() {
      try { p.stdin.end(); } catch (e) { /* already closed */ }
      const code = await closed;
      if (code !== 0) throw new Error('Encoding failed: ' + errTail(err));
      if (failure) throw failure;
    },
    kill() { try { p.kill(); } catch (e) { /* ignore */ } }
  };
}
module.exports = { decodeFrames, startEncoder };
