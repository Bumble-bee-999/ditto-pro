'use strict';
/*
 * One background-removal job in its own process (Electron utility process in the app, a forked Node process in the tests).
 * Its own process, rather than a thread, because onnxruntime's native module can only be loaded once per process, and so a
 * crash in native code can never take the editor down with it. Messages in:  { type: 'start', ffmpeg, opts } | { type: 'cancel' }
 * Messages out: { type: 'progress', pct } | { type: 'done', r } | { type: 'error', error }
 */
const pp = process.parentPort;                       // set inside an Electron utility process
const send = (m) => (pp ? pp.postMessage(m) : process.send(m));
const listen = (fn) => (pp ? pp.on('message', (e) => fn(e.data)) : process.on('message', fn));
let cancelled = false;
listen((m) => {
  if (!m) return;
  if (m.type === 'cancel') { cancelled = true; return; }
  if (m.type !== 'start') return;
  const { removeBackground } = require('./bgremove');
  removeBackground(m.ffmpeg, m.opts, (pct) => send({ type: 'progress', pct }), () => cancelled)
    .then((r) => send({ type: 'done', r }), (e) => send({ type: 'error', error: String((e && e.message) || e) }));
});
