/* Collaboration: review comments (merge rules, hostile files, CSV), and shared-folder lock files / overwrite protection. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const DR = require('../src/review');
const DS = require('../src/shared');
const C = require('../src/collab');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-collab-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };

console.log('Comments on markers:');
const P = DS.newProject({ name: 'Cut 4', fps: 25 });
ok(/^prj_/.test(P.id), 'a new project gets its own id');
const m1 = DR.newMarker(12.5, 'Ana', 1000); P.markers.push(m1);
const c1 = DR.addComment(m1, 'Ana', '  Trim this pause  ', 2000);
ok(c1 && c1.text === 'Trim this pause' && m1.updated === 2000, 'a comment is trimmed and stamps the marker');
ok(DR.addComment(m1, 'Ana', '   ', 3000) === null, 'an empty comment is refused');
DR.setResolved(m1, true, 4000);
ok(m1.resolved && m1.updated === 4000, 'resolving is recorded with a time');

console.log('Two people, one project:');
// Ben gets Ana's review file, adds a reply, a new marker of his own, and un-resolves hers later
const pkgAna = JSON.parse(JSON.stringify(DR.makePackage(P, 'Ana', 5000)));
const Ben = DS.newProject({ name: 'Cut 4', fps: 25 }); Ben.id = P.id;
let r = DR.merge(Ben, pkgAna);
ok(r.ok && r.addedMarkers === 1 && r.addedComments === 1 && Ben.markers[0].resolved, 'Ben receives Ana\'s marker, comment and resolved state');
const bm = Ben.markers[0];
DR.addComment(bm, 'Ben', 'Done, but the music still clips', 6000); DR.setResolved(bm, false, 6000);
const own = DR.newMarker(3, 'Ben', 7000); Ben.markers.push(own); DR.addComment(own, 'Ben', 'Colour looks warm here', 7100);
const pkgBen = JSON.parse(JSON.stringify(DR.makePackage(Ben, 'Ben', 8000)));
r = DR.merge(P, pkgBen);
ok(r.ok && r.addedMarkers === 1 && r.addedComments === 2 && r.updatedMarkers === 1, 'Ana merges Ben\'s review: 1 new marker, 2 new comments, 1 reopened (' + JSON.stringify(r) + ')');
const am = P.markers.find((m) => m.id === m1.id);
ok(am.comments.length === 2 && am.comments[1].author === 'Ben' && am.resolved === false, 'the thread has both voices in time order and Ben\'s newer "reopened" wins');
ok(P.markers[0].t === 3 && P.markers[1].t === 12.5, 'markers stay sorted by time');
r = DR.merge(P, pkgBen);
ok(r.ok && r.addedMarkers === 0 && r.addedComments === 0 && r.updatedMarkers === 0, 'merging the same file twice changes nothing');
// older resolve must not beat newer reopen
const stale = JSON.parse(JSON.stringify(pkgAna)); r = DR.merge(P, stale);
ok(P.markers.find((m) => m.id === m1.id).resolved === false, 'an older copy cannot overwrite a newer decision');

console.log('Wrong project / hostile files:');
const other = DS.newProject({ name: 'Other' });
r = DR.merge(other, pkgAna);
ok(!r.ok && r.differentProject && other.markers.length === 0, 'a review for another project is refused');
r = DR.merge(other, pkgAna, { force: true });
ok(r.ok && other.markers.length === 1, '…unless the user insists');
ok(!DR.merge(P, { format: 'nope', markers: [] }).ok && !DR.merge(P, null).ok && !DR.merge(P, { format: DR.FORMAT }).ok, 'files that are not reviews are refused');
const evil = { format: DR.FORMAT, v: 1, projectId: P.id, markers: [
  { id: '../../x', t: 1, comments: [{ text: 'bad id' }] },
  { id: 'okid', t: 'NaN', name: 'n\u0000ame', comments: [{ id: 'c1', author: 'x'.repeat(5000), at: 'soon', text: 'hi\u0007 there' }, { id: 'c1', text: 'duplicate id' }, 7, null, { text: '' }] },
  { id: 'big', t: -50, comments: Array.from({ length: 900 }, (_, i) => ({ id: 'c' + i, at: i, text: 't' + i })) },
  { id: '__proto__', t: 2 }, { id: 'p'.repeat(100), t: 2 }
] };
const T = DS.newProject({}); T.id = P.id;
r = DR.merge(T, evil);
const okm = T.markers.find((m) => m.id === 'okid'), big = T.markers.find((m) => m.id === 'big');
ok(r.ok && T.markers.length === 2, 'markers with unusable ids are dropped (' + T.markers.map((m) => m.id) + ')');
ok(okm.t === 0 && okm.name === 'name' && okm.comments.length === 1 && okm.comments[0].text === 'hi there' && okm.comments[0].author.length === DR.LIM.author && okm.comments[0].at === 0, 'bad numbers, control characters, duplicates and oversize fields are cleaned');
ok(big.t === 0 && big.comments.length === DR.LIM.comments, 'negative times clamp to 0 and a thread is capped at ' + DR.LIM.comments);
ok(Object.getPrototypeOf(T.markers[0]) === Object.prototype && !('polluted' in {}), 'nothing leaks into prototypes');
const huge = { format: DR.FORMAT, markers: new Array(DR.LIM.markers + 1).fill({ id: 'a' }) };
ok(!DR.merge(T, huge).ok, 'an absurdly long marker list is refused');

console.log('Comment list as CSV:');
const Q = DS.newProject({ name: 'q', fps: 30 }); Q.id = 'p1';
const qm = DR.newMarker(65.5, 'A "quoted" name', 1700000000000); qm.name = '=HYPERLINK("http://x")'; Q.markers.push(qm);
DR.addComment(qm, 'Zed', '+1 line one\nline two, with comma', 1700000100000);
Q.markers.push(DR.newMarker(1, '', 0));
const csv = DR.toCsv(Q), lines = csv.split('\r\n');
ok(lines[0] === '"Timecode","Seconds","Marker","Author","Comment","Resolved","Date"', 'header row');
ok(csv.includes('"00:01:05:15","65.500"') && csv.includes(`"'=HYPERLINK(""http://x"")"`) && csv.includes(`"'+1 line one\nline two, with comma"`), 'timecode, quoting, and spreadsheet-formula neutralising are right');
ok(csv.indexOf('"00:00:01:00"') < csv.indexOf('"00:01:05:15"'), 'rows are in time order');

console.log('Shared-folder locks:');
const file = path.join(tmp, 'film.dpro'); fs.writeFileSync(file, '{}');
const ana = { user: 'ana', host: 'PC-A', session: 's-ana' }, ben = { user: 'ben', host: 'PC-B', session: 's-ben' };
let now = 1_000_000;
ok(C.state(file, ana, now).state === 'free', 'no lock to begin with');
ok(C.acquire(file, ana, now).ok && fs.existsSync(C.lockPath(file)), 'Ana opens it and a lock file appears beside it');
ok(C.state(file, ana, now + 5000).state === 'mine' && C.state(file, ben, now + 5000).state === 'other', 'Ana sees her own lock, Ben sees someone else\'s');
const refused = C.acquire(file, ben, now + 5000);
ok(!refused.ok && refused.lock.user === 'ana', 'Ben cannot take it quietly (he is told it is Ana\'s)');
ok(C.refresh(file, ana, now + 30000) && C.state(file, ben, now + 100000).state === 'other', 'her 30-second heartbeat keeps it alive past 90 s');
ok(!C.refresh(file, ben, now + 31000), 'Ben cannot refresh Ana\'s lock');
ok(C.state(file, ben, now + 30000 + C.STALE_MS + 1).state === 'stale', 'if Ana\'s app dies, the lock goes stale after 90 s');
ok(C.acquire(file, ben, now + 200000).ok && C.state(file, ben, now + 200001).state === 'mine', 'Ben may then take over');
ok(!C.release(file, ana) && fs.existsSync(C.lockPath(file)), 'Ana cannot release Ben\'s lock');
ok(C.release(file, ben) && !fs.existsSync(C.lockPath(file)), 'Ben releases his; the file disappears');
fs.writeFileSync(C.lockPath(file), 'x'.repeat(100000)); ok(C.state(file, ana, now).state === 'free', 'an oversize / garbage lock file is ignored');
fs.writeFileSync(C.lockPath(file), '{not json'); ok(C.state(file, ana, now).state === 'free', 'a corrupt lock file is ignored');
fs.writeFileSync(C.lockPath(file), JSON.stringify({ user: 'e\u0000vil', host: 'h'.repeat(500), session: 'z', since: 1, beat: now }));
const hs = C.state(file, ana, now);
ok(hs.state === 'other' && hs.lock.user === 'evil' && hs.lock.host.length === 80, 'lock text shown to the user is cleaned and shortened');
fs.unlinkSync(C.lockPath(file));
const ro = path.join(tmp, 'ro'); fs.mkdirSync(ro); const rf = path.join(ro, 'a.dpro'); fs.writeFileSync(rf, '{}'); fs.chmodSync(ro, 0o555);
const rr = C.acquire(rf, ana, now);
fs.chmodSync(ro, 0o755);
ok(rr.ok && (rr.unwritable || process.getuid && process.getuid() === 0), 'a read-only folder never blocks opening');

console.log('Overwrite protection:');
const fp = C.fingerprint(file);
ok(C.saveCheck(file, ana, fp, now).action === 'save', 'untouched file: save straight away');
fs.writeFileSync(file, '{"changed":true}'); const t0 = new Date(Date.now() + 5000); fs.utimesSync(file, t0, t0);
const ck = C.saveCheck(file, ana, fp, now);
ok(ck.action === 'ask' && ck.reason === 'changed', 'someone else wrote the file since you opened it: ask first');
C.acquire(file, ben, now);
const ck2 = C.saveCheck(file, ana, C.fingerprint(file), now + 1000);
ok(ck2.action === 'ask' && ck2.reason === 'locked' && ck2.lock.user === 'ben', 'someone else holds the lock: ask first');
ok(C.saveCheck(file, ana, null, now + 1000).action === 'ask', 'a lock is checked even for a project you never opened here');
C.release(file, ben);
ok(C.saveCheck(file, ana, C.fingerprint(file), now).action === 'save', 'after re-reading the new file it is fine to save again');
process.exit(failed ? 1 : 0);
