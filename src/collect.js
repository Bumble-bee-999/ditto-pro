'use strict';
/* Ditto Pro — "Collect project files": copies every file a project uses into one folder, next to a copy of the project
   whose paths point at the copies. The collected folder can be archived or handed to someone else.
   When a project is opened and a file is not where the project says, the app also looks beside the project (see findBeside). */
const fs = require('fs');
const path = require('path');

const baseName = (p) => String(p || '').split(/[\\/]/).pop();
const safeName = (s) => (String(s || 'Untitled').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().replace(/[. ]+$/, '') || 'Untitled').slice(0, 80);

// every clip of the project, including the clips inside nested sequences
function allClips(obj) {
  const out = (obj.clips || []).slice();
  Object.values(obj.nests || {}).forEach((n) => { (n && n.clips || []).forEach((c) => out.push(c)); });
  return out;
}
/** the files a project refers to: [{ path, kind: 'media' | 'lut' }] (each path once) */
function filesOf(obj) {
  const seen = new Set(), out = [];
  const add = (p, kind) => { if (typeof p === 'string' && p && !seen.has(p)) { seen.add(p); out.push({ path: p, kind }); } };
  (obj.media || []).forEach((m) => { if (m && !m.nest) add(m.path, 'media'); });
  allClips(obj).forEach((c) => { if (c && c.fx && c.fx.lut && c.fx.lut.path) add(c.fx.lut.path, 'lut'); });
  return out;
}

/**
 * Copies the project's files into  <destParent>/<project name> (collected)/Media  and writes the project beside them.
 * hooks: { onProgress({ done, total, name }), exists(p), copy(src, dst) }  (the last two are for tests)
 * Returns { dir, project, copied, bytes, skipped: [names] }.
 */
async function collectProject(obj, destParent, hooks) {
  hooks = hooks || {};
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.clips)) throw new Error('There is no project to collect.');
  const name = safeName(obj.name);
  let dir = path.join(destParent, name + ' (collected)');
  for (let i = 2; fs.existsSync(dir) && fs.readdirSync(dir).length; i++) dir = path.join(destParent, name + ' (collected ' + i + ')');
  const mediaDir = path.join(dir, 'Media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const files = filesOf(obj), map = new Map(), used = new Set(), skipped = [];
  let bytes = 0, done = 0;
  for (const f of files) {
    const src = f.path, bn = baseName(src);
    if (hooks.onProgress) hooks.onProgress({ done, total: files.length, name: bn });
    done++;
    let st = null;
    try { st = fs.statSync(src); } catch (e) { /* missing */ }
    if (!st || !st.isFile()) { skipped.push(bn || src); continue; }
    // unique name inside Media (case-insensitive, as Windows compares names)
    const ext = path.extname(bn), stem = safeName(bn.slice(0, bn.length - ext.length)) || 'file';
    let out = stem + ext;
    for (let i = 2; used.has(out.toLowerCase()); i++) out = stem + ' (' + i + ')' + ext;
    used.add(out.toLowerCase());
    const dst = path.join(mediaDir, out);
    await fs.promises.copyFile(src, dst);
    bytes += st.size;
    map.set(src, dst);
  }
  if (hooks.onProgress) hooks.onProgress({ done: files.length, total: files.length, name: '' });
  // the copy of the project points at the copies
  const copy = JSON.parse(JSON.stringify(obj));
  (copy.media || []).forEach((m) => { if (m && map.has(m.path)) m.path = map.get(m.path); });
  allClips(copy).forEach((c) => { if (c && c.fx && c.fx.lut && map.has(c.fx.lut.path)) c.fx.lut.path = map.get(c.fx.lut.path); });
  const project = path.join(dir, name + '.dpro');
  fs.writeFileSync(project, JSON.stringify(copy, null, 1), 'utf8');
  return { dir, project, copied: map.size, bytes, skipped };
}

/** For files that are not where the project says: the same file name beside the project or in its Media folder. { oldPath: foundPath } */
function findBeside(projectPath, paths) {
  const out = {};
  if (!projectPath) return out;
  const base = path.dirname(projectPath);
  for (const p of (Array.isArray(paths) ? paths : []).slice(0, 5000)) {
    const bn = baseName(p);
    if (!bn || bn === '.' || bn === '..') continue;
    for (const d of [path.join(base, 'Media'), base]) {
      const c = path.join(d, bn);
      try { if (fs.statSync(c).isFile()) { out[p] = c; break; } } catch (e) { /* not there */ }
    }
  }
  return out;
}

module.exports = { collectProject, findBeside, filesOf, safeName };
