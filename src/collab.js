'use strict';
/*
 * Ditto Pro — working on a project in a shared folder (a network drive, OneDrive, Dropbox, a NAS).
 * There is no server: while a project is open, a small "<project>.dpro.lock" file beside it says who has it, and is
 * refreshed every half minute. Anyone opening the project meanwhile is told, and can open a private copy instead. A lock
 * that stops being refreshed (crash, power cut) goes stale after 90 s and is ignored. On saving, the app also checks that
 * nobody else changed the file since it was opened, so one person can never silently overwrite another's work.
 */
const fs = require('fs');

const STALE_MS = 90 * 1000;
const BEAT_MS = 30 * 1000;
const MAX_LOCK_BYTES = 4096;

const lockPath = (file) => file + '.lock';
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n);

function read(file) {
  try {
    const p = lockPath(file), st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_LOCK_BYTES) return null;
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!o || typeof o !== 'object') return null;
    return { user: clean(o.user, 80), host: clean(o.host, 80), session: clean(o.session, 80), since: +o.since || 0, beat: +o.beat || 0 };
  } catch (e) { return null; }
}

/** 'free' | 'mine' (this app run holds it) | 'other' (someone else, still active) | 'stale' (someone's, long abandoned) */
function state(file, me, now) {
  const l = read(file);
  if (!l) return { state: 'free', lock: null };
  if (l.session && l.session === me.session) return { state: 'mine', lock: l };
  return { state: (now || Date.now()) - l.beat > STALE_MS ? 'stale' : 'other', lock: l };
}

function write(file, me, since, now) {
  const body = JSON.stringify({ user: clean(me.user, 80), host: clean(me.host, 80), session: me.session, since, beat: now });
  const tmp = lockPath(file) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, lockPath(file));
}

/** Takes the lock (overwriting a stale or foreign one only when `take` is true). Never throws: a read-only folder just means no lock. */
function acquire(file, me, now, take) {
  now = now || Date.now();
  const st = state(file, me, now);
  if (st.state === 'other' && !take) return { ok: false, state: st.state, lock: st.lock };
  try { write(file, me, st.state === 'mine' ? st.lock.since : now, now); return { ok: true, state: st.state }; } catch (e) { return { ok: true, state: st.state, unwritable: true }; }
}
function refresh(file, me, now) {
  now = now || Date.now();
  const st = state(file, me, now);
  if (st.state !== 'mine') return false;
  try { write(file, me, st.lock.since, now); return true; } catch (e) { return false; }
}
function release(file, me) {
  const st = state(file, me, Date.now());
  if (st.state !== 'mine') return false;
  try { fs.unlinkSync(lockPath(file)); return true; } catch (e) { return false; }
}

const fingerprint = (file) => { try { const s = fs.statSync(file); return { mtimeMs: Math.round(s.mtimeMs), size: s.size }; } catch (e) { return null; } };
/** True when the file on disk is not the one we opened or last saved (someone else wrote it). */
function changedSince(file, fp) {
  if (!fp) return false;
  const now = fingerprint(file);
  return !!now && (now.size !== fp.size || Math.abs(now.mtimeMs - fp.mtimeMs) > 1);
}

/** What to do when asked to save over `file` (pure, so the decision is tested). */
function saveCheck(file, me, fp, now) {
  const st = state(file, me, now);
  if (st.state === 'other') return { action: 'ask', reason: 'locked', lock: st.lock };
  if (changedSince(file, fp)) return { action: 'ask', reason: 'changed' };
  return { action: 'save' };
}

module.exports = { STALE_MS, BEAT_MS, lockPath, read, state, acquire, refresh, release, fingerprint, changedSince, saveCheck };
