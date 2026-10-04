'use strict';
/* Small DOM helpers, icons, toasts and modal dialogs. */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function el(tag, attrs, children) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  (Array.isArray(children) ? children : children != null ? [children] : []).forEach((c) => {
    if (c == null || c === false) return;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return n;
}

const ICONS = {
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" stroke="none"/>',
  'skip-start': '<path d="M6 5v14"/><path d="M19 5.5v13L8.5 12z" fill="currentColor"/>',
  'skip-end': '<path d="M18 5v14"/><path d="M5 5.5v13L15.5 12z" fill="currentColor"/>',
  'step-back': '<path d="M15 6l-6 6 6 6"/>',
  'step-fwd': '<path d="M9 6l6 6-6 6"/>',
  pointer: '<path d="M5 3l14 8-6 1.8L10.5 19z" fill="currentColor"/>',
  razor: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
  magnet: '<path d="M6 3v9a6 6 0 0012 0V3"/><path d="M6 8h4M14 8h4"/>',
  'zoom-in': '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M11 8v6M8 11h6"/>',
  'zoom-out': '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M8 11h6"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12" transform="translate(0 -4)"/>',
  redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 12" transform="translate(0 -4)"/>',
  diamond: '<path d="M12 3l8 9-8 9-8-9z"/>',
  'diamond-fill': '<path d="M12 3l8 9-8 9-8-9z" fill="currentColor"/>',
  sliders: '<path d="M5 4v16M12 4v16M19 4v16"/><rect x="3" y="13" width="4" height="3" fill="currentColor"/><rect x="10" y="7" width="4" height="3" fill="currentColor"/><rect x="17" y="11" width="4" height="3" fill="currentColor"/>',
  chevL: '<path d="M14 6l-6 6 6 6"/>',
  chevR: '<path d="M10 6l6 6-6 6"/>',
  chevD: '<path d="M6 9l6 6 6-6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M3 3l18 18"/><path d="M10.5 6.2A9.6 9.6 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 4M6.4 7.6A17 17 0 002 12s4 7 10 7a9.5 9.5 0 004-.9"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/>',
  'volume-off': '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  wand: '<path d="M4 20L15 9M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 12l.7 1.3L21 14l-1.3.7L19 16l-.7-1.3L17 14l1.3-.7z"/>',
  flag: '<path d="M5 21V4M5 5h11l-2 4 2 4H5"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  swap: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>'
};
function icon(name) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
}
function ibtn(name, title, onclick, cls) {
  const b = el('button', { class: 'ibtn ' + (cls || ''), title: title || '', html: icon(name) });
  if (onclick) b.addEventListener('click', onclick);
  return b;
}

function toast(msg, kind, ms) {
  const t = el('div', { class: 'toast ' + (kind || ''), text: msg });
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, ms || (kind === 'err' ? 6500 : 3200));
}

// returns {close, root, body}
function modal(opts) {
  const back = el('div', { class: 'back' });
  const body = el('div', { class: 'mb' }, opts.body);
  const foot = el('div', { class: 'mf' });
  const m = el('div', { class: 'modal', style: opts.width ? 'width:' + opts.width + 'px' : '' }, [el('h2', { text: opts.title }), body, foot]);
  back.appendChild(m);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape' && opts.dismissable !== false) { e.stopPropagation(); close(); opts.onClose && opts.onClose(); }
  };
  document.addEventListener('keydown', onKey, true);
  (opts.buttons || []).forEach((b) => {
    const btn = el('button', { class: b.primary ? 'primary' : 'btn' + (b.danger ? ' danger' : ''), text: b.label });
    btn.addEventListener('click', () => { const keep = b.onClick && b.onClick({ close, btn }); if (keep !== false && !b.keepOpen) close(); });
    foot.appendChild(btn);
    b.el = btn;
  });
  $('#modalRoot').appendChild(back);
  return { close, root: m, body, foot, buttons: opts.buttons };
}

function confirmDialog(title, text, okLabel, danger) {
  return new Promise((resolve) => {
    modal({
      title, body: el('div', { text, style: 'line-height:1.5;white-space:pre-wrap' }), dismissable: true, onClose: () => resolve(false),
      buttons: [
        { label: 'Cancel', onClick: () => resolve(false) },
        { label: okLabel || 'OK', primary: !danger, danger: !!danger, onClick: () => resolve(true) }
      ]
    });
  });
}
// three-way: returns 'yes' | 'no' | 'cancel'
function askSave(name) {
  return new Promise((resolve) => {
    modal({
      title: 'Save changes?', body: el('div', { text: 'Do you want to save changes to "' + name + '" before closing?' }), onClose: () => resolve('cancel'),
      buttons: [
        { label: 'Cancel', onClick: () => resolve('cancel') },
        { label: "Don't save", danger: true, onClick: () => resolve('no') },
        { label: 'Save', primary: true, onClick: () => resolve('yes') }
      ]
    });
  });
}

const fmtDur = (s) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m + ':' + String(r).padStart(2, '0');
};
const fmtSecs = (s) => (Math.round(s * 100) / 100).toString();
const baseName = (p) => String(p || '').split(/[\\/]/).pop();
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
