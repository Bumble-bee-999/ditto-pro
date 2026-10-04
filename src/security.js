'use strict';
/* Ditto Pro — security helpers (pure, unit-tested). Project files, imported edit lists and the renderer are all treated
   as untrusted input: a crafted file must not be able to make FFmpeg read network URLs / special protocols / network
   shares, or smuggle command-line options. */
const MAX_PROJECT_BYTES = 256 * 1024 * 1024;
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

// A local, absolute filesystem path. Rejects URLs / FFmpeg pseudo-protocols (http:, concat:, subfile:, ...),
// UNC / device paths (credential-leak vectors on Windows), option-looking strings and control characters.
function isSafeLocalPath(p) {
  if (typeof p !== 'string' || !p || p.length > 4096) return false;
  if (/[\0-\x1f]/.test(p)) return false;
  if (/^[\\/]{2}/.test(p)) return false;                 // \\server\share, //server, \\?\ and \\.\ device paths
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;      // drive-letter path
  if (p[0] === '/') return true;                         // POSIX absolute (dev / tests)
  return false;                                          // relative, "-opt", "http://", "concat:a|b", "pipe:", ...
}
function assertSafePath(p, what) {
  if (!isSafeLocalPath(p)) throw new Error((what || 'File') + ' path is not allowed: ' + String(p).slice(0, 80));
  return p;
}

// Called on every project that comes from outside the app (open, import, autosave): unsafe media/LUT paths are
// dropped (the clip shows as offline and can be relinked) and counted so the user can be told.
function sanitizeProject(project) {
  let removed = 0;
  const bad = (p) => p && !isSafeLocalPath(p);
  (project.media || []).forEach((m) => { if (bad(m.path)) { m.path = ''; m.missing = true; removed++; } });
  const DG = require('./grade'), DS = require('./shared');
  const fixClip = (c) => {
    if (c && c.tr != null) c.tr = c.tr && typeof c.tr === 'object' && typeof c.tr.type === 'string' && Object.prototype.hasOwnProperty.call(DS.TRANSITIONS, c.tr.type) && Number.isFinite(+c.tr.dur) ? { type: c.tr.type, dur: Math.min(60, Math.max(0.05, +c.tr.dur)) } : null;
    if (c && c.kf !== undefined) c.kf = DS.cleanKf(c.kf);
    if (c && c.blend !== undefined) c.blend = DS.cleanBlend(c.blend);
    if (c && c.color !== undefined) c.color = DS.cleanLabel(c.color);
    if (c && c.fx) c.fx = Object.assign(DS.cleanFx(c.fx), { color: c.fx.color != null ? c.fx.color : null });
    if (c && c.fx && c.fx.lut && bad(c.fx.lut.path)) { c.fx.lut = null; removed++; }
    if (c && c.fx && c.fx.color != null) c.fx.color = DG.active(c.fx.color) ? DG.normalize(c.fx.color) : null;   // numbers only, in range
  };
  (project.clips || []).forEach(fixClip);
  Object.values(project.nests || {}).forEach((n) => {
    (n.clips || []).forEach(fixClip);
  });
  return removed;
}

// Only the app's own page may call privileged IPC.
function isTrustedSender(e, indexUrl) {
  try {
    const f = e && e.senderFrame;
    if (!f || f.parent) return false;                    // top frame only
    const norm = (u) => { const x = new URL(u); return x.protocol + decodeURIComponent(x.pathname).toLowerCase(); };
    return norm(f.url) === norm(indexUrl);            // same file, whatever the URL-encoding / drive-letter case
  } catch (_) { return false; }
}

// URLs the app may open in the user's browser (feedback links only).
function isAllowedExternal(url, hosts) {
  try { const u = new URL(url); return u.protocol === 'https:' && hosts.includes(u.hostname); } catch (_) { return false; }
}
module.exports = { isSafeLocalPath, assertSafePath, sanitizeProject, isTrustedSender, isAllowedExternal, MAX_PROJECT_BYTES, MAX_IMPORT_BYTES };
