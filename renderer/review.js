'use strict';
/* Ditto Pro — Review panel: comment threads on timeline markers, resolve / reopen, and hand a review to a colleague as a
   small file (.dreview) that they can send back to merge in. Works through shared folders; no server, nothing uploaded. */
const Review = (() => {
  const root = $('#tab-rv');
  let showResolved = true, focusId = null;

  const rel = (ms) => {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(ms).toLocaleDateString();
  };
  const typing = () => { const a = document.activeElement; return a && root.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') && a.value; };

  function render(force) {
    if (root.classList.contains('hidden') && !force) return;
    if (!force && typing()) return;
    root.innerHTML = '';
    const me = el('input', { type: 'text', value: S.author(), maxlength: String(DR.LIM.author), style: 'flex:1;min-width:0', title: 'Your comments are signed with this name' });
    me.addEventListener('change', () => { S.setAuthor(me.value); toast('Comments will be signed "' + S.author() + '".'); });
    me.addEventListener('keydown', (e) => e.stopPropagation());
    root.appendChild(el('div', { class: 'txbar' }, [el('span', { class: 'dim', text: 'You are' }), me]));
    root.appendChild(el('div', { class: 'txbar' }, [
      el('button', { class: 'btn', text: 'Comment at playhead', title: 'Drops a marker here and starts a comment (M adds a bare marker)', onclick: () => { const m = S.addMarker(); focusId = m.id; render(true); } }),
      el('button', { class: 'btn', text: 'Export review…', title: 'Save every comment as a small file for a colleague', onclick: exportReview }),
      el('button', { class: 'btn', text: 'Import review…', title: 'Merge a colleague\'s comments into this project', onclick: importReview }),
      el('button', { class: 'btn', text: 'Export CSV…', onclick: exportCsv })
    ]));
    const chk = el('input', { type: 'checkbox' }); chk.checked = showResolved;
    chk.addEventListener('change', () => { showResolved = chk.checked; render(true); });
    const ms = S.project.markers;
    const open = ms.filter((m) => !m.resolved).length;
    root.appendChild(el('div', { class: 'txbar' }, [el('label', { class: 'chk' }, [chk, el('span', { text: 'Show resolved' })]), el('span', { class: 'dim', id: 'rvCount', text: ms.length ? open + ' open of ' + ms.length : '' })]));
    const body = el('div', { class: 'txbody', style: 'user-select:text' });
    const list = ms.filter((m) => showResolved || !m.resolved);
    if (!list.length) {
      body.appendChild(el('div', { class: 'bin-empty' }, [el('b', { text: ms.length ? 'Everything is resolved' : 'No comments yet' }), el('div', { text: ms.length ? 'Tick "Show resolved" to see them.' : 'Move the playhead to a moment, click "Comment at playhead" and write what should change. Send a review file to a colleague, or merge theirs in.' })]));
    }
    list.forEach((m) => body.appendChild(card(m)));
    root.appendChild(body);
    if (focusId) {
      const c = root.querySelector('[data-mk="' + CSS.escape(focusId) + '"]');
      if (c) { c.scrollIntoView({ block: 'nearest' }); const ta = c.querySelector('textarea'); if (ta) ta.focus(); }
      focusId = null;
    }
  }

  function card(m) {
    const title = el('input', { type: 'text', value: m.name, placeholder: 'Untitled marker', maxlength: String(DR.LIM.name), class: 'rvtitle' });
    title.addEventListener('change', () => S.renameMarker(m.id, title.value));
    title.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') title.blur(); });
    const ta = el('textarea', { rows: '2', placeholder: 'Add a comment…  (Ctrl+Enter to post)', maxlength: String(DR.LIM.text), class: 'rvta' });
    const post = () => { if (S.addComment(m.id, ta.value)) { focusId = m.id; render(true); } };
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); } });
    const node = el('div', { class: 'rvcard' + (m.resolved ? ' done' : ''), 'data-mk': m.id }, [
      el('div', { class: 'rvhead' }, [
        el('button', { class: 'rvtime', text: DS.fmtTC(m.t, S.project.fps), title: 'Jump to this moment', onclick: () => { Player.stop(); S.seek(m.t); } }),
        title,
        el('button', { class: 'ibtn', title: m.resolved ? 'Reopen' : 'Mark as resolved', html: m.resolved ? '↺' : '✓', onclick: () => S.resolveMarker(m.id, !m.resolved) }),
        el('button', { class: 'ibtn', title: 'Delete this marker and its comments', html: '✕', onclick: () => { if (!m.comments.length) return S.removeMarker(m.id); confirmDialog('Delete marker', 'Delete this marker and its ' + m.comments.length + ' comment' + (m.comments.length > 1 ? 's' : '') + '?', 'Delete', true).then((y) => { if (y) S.removeMarker(m.id); }); } })
      ])
    ]);
    if (m.author || m.created) node.appendChild(el('div', { class: 'dim rvmeta', text: (m.author ? m.author + ' · ' : '') + rel(m.created) }));
    m.comments.forEach((c) => node.appendChild(el('div', { class: 'rvcm' }, [el('div', { class: 'rvwho' }, [el('b', { text: c.author }), el('span', { class: 'dim', text: ' · ' + rel(c.at) })]), el('div', { class: 'rvtxt', text: c.text })])));
    node.appendChild(el('div', { class: 'rvreply' }, [ta, el('button', { class: 'btn', text: 'Post', onclick: post })]));
    return node;
  }

  async function exportReview() {
    if (!S.project.markers.length) return toast('Add a comment first.', 'err');
    const pkg = DR.makePackage(S.rootProject(), S.author(), Date.now());
    try {
      const r = await window.ditto.exportReview({ json: JSON.stringify(pkg, null, 1), name: S.project.name });
      if (r) toast('Review saved. Send it to your colleague and ask them to send theirs back.', 'ok', 5000);
    } catch (e) { toast('Could not save the review: ' + e.message, 'err'); }
  }
  async function importReview() {
    const r = await window.ditto.importReview();
    if (!r) return;
    if (r.error) return toast('Could not open the review: ' + r.error, 'err');
    let pkg; try { pkg = JSON.parse(r.json); } catch (e) { return toast('That file is not a review file.', 'err'); }
    let res = mergeInto(pkg, false);
    if (res.differentProject) {
      const yes = await confirmDialog('Different project', res.error + '\n\nAdd its comments anyway? Their timecodes may not match this edit.', 'Add anyway');
      if (!yes) return;
      res = mergeInto(pkg, true);
    }
    if (!res.ok) return toast(res.error, 'err');
    toast(res.addedComments || res.addedMarkers || res.updatedMarkers ? 'Merged ' + (res.from ? res.from + '\'s' : 'the') + ' review: ' + res.addedMarkers + ' new marker' + (res.addedMarkers === 1 ? '' : 's') + ', ' + res.addedComments + ' new comment' + (res.addedComments === 1 ? '' : 's') + ', ' + res.updatedMarkers + ' updated.' : 'Nothing new in that review.', 'ok', 5000);
  }
  function mergeInto(pkg, force) {
    const rp = S.rootProject();
    const dry = DR.merge({ id: rp.id, markers: DS.clone(rp.markers) }, pkg, { force });   // check first so a refusal leaves no undo step behind
    if (!dry.ok) return dry;
    S.checkpoint();
    const res = DR.merge(rp, pkg, { force });
    S.change();
    return res;
  }
  async function exportCsv() {
    if (!S.project.markers.length) return toast('There is nothing to export yet.', 'err');
    try { const r = await window.ditto.exportCommentsCsv({ csv: DR.toCsv(S.rootProject()), name: S.project.name }); if (r) toast('Saved the comment list.', 'ok'); } catch (e) { toast('Could not save: ' + e.message, 'err'); }
  }

  S.on('change', (structural) => { render(); });
  S.on('load', () => render());
  render(true);
  return { render, focus: (id) => { focusId = id; const b = document.querySelector('#leftTabs [data-tab="rv"]'); if (b) b.click(); else render(true); }, mergeInto };
})();
