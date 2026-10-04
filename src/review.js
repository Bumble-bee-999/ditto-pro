/*
 * Ditto Pro — review comments (file-based collaboration).
 * Markers carry a comment thread and a resolved flag. A "review package" (.dreview) is a small JSON file that holds
 * only those markers, so a colleague can comment on their copy of the project and send the file back; importing it merges
 * their comments into yours without touching the edit. Everything arriving from a file is treated as untrusted and
 * rebuilt field by field. Pure code, used by the renderer (window.DR) and by the tests (Node).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const LIM = { markers: 5000, comments: 500, text: 4000, name: 200, author: 80 };
  const FORMAT = 'ditto-review';

  const cleanText = (s, max) => (typeof s === 'string' ? s : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  const cleanId = (s) => (typeof s === 'string' && /^[A-Za-z0-9_\-]{1,64}$/.test(s) && !/^__/.test(s) ? s : null);
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const uid = (p) => p + '_' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);

  function normComment(c) {
    if (!c || typeof c !== 'object') return null;
    const text = cleanText(c.text, LIM.text);
    if (!text) return null;
    return { id: cleanId(c.id) || uid('cm'), author: cleanText(c.author, LIM.author) || 'Someone', at: Math.max(0, num(c.at, 0)), text };
  }
  /** Rebuilds a marker with every field checked. Older projects' plain markers ({id,t,name}) are upgraded. */
  function normMarker(m) {
    if (!m || typeof m !== 'object') return null;
    const id = cleanId(m.id); if (!id) return null;
    const seen = new Set(), comments = [];
    (Array.isArray(m.comments) ? m.comments : []).slice(0, LIM.comments).forEach((c) => { const n = normComment(c); if (n && !seen.has(n.id)) { seen.add(n.id); comments.push(n); } });
    comments.sort((a, b) => a.at - b.at);
    const created = Math.max(0, num(m.created, 0));
    return { id, t: Math.max(0, num(m.t, 0)), name: cleanText(m.name, LIM.name), author: cleanText(m.author, LIM.author), created, updated: Math.max(created, num(m.updated, created), comments.length ? comments[comments.length - 1].at : 0), resolved: !!m.resolved, comments };
  }

  function newMarker(t, author, now) { return { id: uid('mk'), t: Math.max(0, t), name: '', author: cleanText(author, LIM.author), created: now, updated: now, resolved: false, comments: [] }; }
  function addComment(marker, author, text, now) {
    const t = cleanText(text, LIM.text); if (!t || marker.comments.length >= LIM.comments) return null;
    const c = { id: uid('cm'), author: cleanText(author, LIM.author) || 'Someone', at: now, text: t };
    marker.comments.push(c); marker.updated = now;
    return c;
  }
  function setResolved(marker, flag, now) { marker.resolved = !!flag; marker.updated = now; }

  function makePackage(project, author, now) {
    return {
      format: FORMAT, v: 1, projectId: cleanId(project.id) || '', projectName: cleanText(project.name, LIM.name), fps: num(project.fps, 30),
      author: cleanText(author, LIM.author), exported: now,
      markers: (project.markers || []).map(normMarker).filter(Boolean)
    };
  }
  function readPackage(pkg) {
    if (!pkg || typeof pkg !== 'object' || pkg.format !== FORMAT) return { ok: false, error: 'This is not a Ditto Pro review file.' };
    if (!Array.isArray(pkg.markers)) return { ok: false, error: 'The review file has no comments in it.' };
    if (pkg.markers.length > LIM.markers) return { ok: false, error: 'The review file is too large.' };
    return { ok: true, projectId: cleanId(pkg.projectId) || '', projectName: cleanText(pkg.projectName, LIM.name), author: cleanText(pkg.author, LIM.author), markers: pkg.markers.map(normMarker).filter(Boolean) };
  }

  /**
   * Merges a review file into the project's markers. Comments are united by id; for a marker both sides know, the side
   * changed more recently decides its position, title and resolved state. Returns counts, or an error / differentProject.
   */
  function merge(project, pkg, opts) {
    opts = opts || {};
    const r = readPackage(pkg);
    if (!r.ok) return r;
    if (!opts.force && r.projectId && project.id && r.projectId !== project.id) return { ok: false, differentProject: true, projectName: r.projectName, error: 'This review was made for "' + (r.projectName || 'another project') + '", not this project.' };
    const mine = new Map((project.markers || []).map(normMarker).filter(Boolean).map((m) => [m.id, m]));
    let addedMarkers = 0, addedComments = 0, updatedMarkers = 0;
    r.markers.forEach((theirs) => {
      const ours = mine.get(theirs.id);
      if (!ours) {
        if (mine.size >= LIM.markers) return;
        mine.set(theirs.id, theirs); addedMarkers++; addedComments += theirs.comments.length; return;
      }
      let changed = false;
      const have = new Set(ours.comments.map((c) => c.id));
      theirs.comments.forEach((c) => { if (!have.has(c.id) && ours.comments.length < LIM.comments) { ours.comments.push(c); have.add(c.id); addedComments++; changed = true; } });
      ours.comments.sort((a, b) => a.at - b.at);
      if (theirs.updated > ours.updated) {
        if (ours.resolved !== theirs.resolved || ours.name !== theirs.name || Math.abs(ours.t - theirs.t) > 1e-6) changed = true;
        ours.resolved = theirs.resolved; ours.name = theirs.name; ours.t = theirs.t; ours.updated = theirs.updated;
      }
      ours.updated = Math.max(ours.updated, ours.comments.length ? ours.comments[ours.comments.length - 1].at : 0);
      if (changed) updatedMarkers++;
    });
    project.markers = Array.from(mine.values()).sort((a, b) => a.t - b.t);
    return { ok: true, addedMarkers, addedComments, updatedMarkers, from: r.author };
  }

  function tc(t, fps) {
    fps = Math.round(fps || 30); const f = Math.max(0, Math.round(t * fps)), s = Math.floor(f / fps), p = (n) => String(n).padStart(2, '0');
    return p(Math.floor(s / 3600)) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60) + ':' + p(f % fps);
  }
  /** Comments as CSV (one row per comment, or per bare marker) for spreadsheets and other editors. */
  function toCsv(project) {
    // cells that start with = + - @ are prefixed so a spreadsheet never runs them as formulas
    const q = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const rows = [['Timecode', 'Seconds', 'Marker', 'Author', 'Comment', 'Resolved', 'Date'].map(q).join(',')];
    (project.markers || []).map(normMarker).filter(Boolean).sort((a, b) => a.t - b.t).forEach((m) => {
      const base = [tc(m.t, project.fps), m.t.toFixed(3), m.name];
      const date = (ms) => (ms ? new Date(ms).toISOString() : '');
      if (!m.comments.length) rows.push(base.concat([m.author, '', m.resolved ? 'yes' : 'no', date(m.created)]).map(q).join(','));
      m.comments.forEach((c) => rows.push(base.concat([c.author, c.text, m.resolved ? 'yes' : 'no', date(c.at)]).map(q).join(',')));
    });
    return rows.join('\r\n') + '\r\n';
  }

  return { LIM, FORMAT, cleanText, cleanId, normMarker, normComment, newMarker, addComment, setResolved, makePackage, readPackage, merge, toCsv, tc };
});
