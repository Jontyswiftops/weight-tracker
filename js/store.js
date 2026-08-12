// Local-first data layer.
//
// Signed out: reads/writes the ORIGINAL app's localStorage keys (wt:data,
// wt:photo:*) so the app behaves exactly like the old tracker with zero
// migration. Signed in: per-user wt2:<uid>:* keys mirror Supabase, with an
// outbox for writes made offline. Server state wins on pull, except for
// ops still queued locally.
import * as cloud from './cloud.js';
import { todayStr } from './util.js';

const LEGACY = 'wt:data', LEGACY_PB = 'wt:photo:before', LEGACY_PA = 'wt:photo:after';

let ns = null; // null = signed out (legacy keys); otherwise the user id
const K = suffix => 'wt2:' + ns + ':' + suffix;

const changeCbs = new Set();
export function onChange(cb) { changeCbs.add(cb); return () => changeCbs.delete(cb); }
const emit = () => changeCbs.forEach(cb => { try { cb(); } catch {} });

function jget(key, fallback) {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; }
  catch { return fallback; }
}
function jset(key, v) { localStorage.setItem(key, JSON.stringify(v)); }

// ---- namespace ----

export function setUser(uid) { ns = uid || null; }
export const signedIn = () => ns != null;

// ---- reads ----

function legacyBlob() { return jget(LEGACY, { entries: [], goal: null, startW: null }); }

export function entries() {
  const list = ns ? jget(K('entries'), []) : legacyBlob().entries || [];
  return [...list].sort((a, b) => a.d < b.d ? -1 : 1);
}

export function tracker() {
  if (!ns) { const b = legacyBlob(); return { goal: b.goal ?? null, startW: b.startW ?? null }; }
  return jget(K('tracker'), { goal: null, startW: null });
}

export function photo(which) {
  if (!ns) return jget(which === 'before' ? LEGACY_PB : LEGACY_PA, null);
  return jget(K('photo:' + which), null);
}

// ---- outbox ----

function outbox() { return jget(K('outbox'), []); }
function setOutbox(list) { jset(K('outbox'), list); }

function enqueue(op) {
  if (!ns) return;
  const key = op.t + ':' + (op.d || '');
  setOutbox(outbox().filter(o => (o.t + ':' + (o.d || '')) !== key).concat([op]));
}

let flushTimer = null;
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flush().catch(() => {}); }, 400);
}

export async function flush() {
  if (!ns || !cloud.user() || !navigator.onLine) return;
  let ob = outbox();
  while (ob.length) {
    const op = ob[0];
    try {
      if (op.t === 'up') await cloud.pushEntries([{ d: op.d, w: op.w }]);
      else if (op.t === 'del') await cloud.deleteEntryRemote(op.d);
      else if (op.t === 'tracker') await cloud.pushTracker(tracker());
    } catch (e) {
      // leave the op queued; try again on the next flush
      return;
    }
    ob = outbox().slice(1);
    setOutbox(ob);
  }
}

export const pendingWrites = () => ns ? outbox().length : 0;

// ---- writes (local first, then queue) ----

export function saveEntry(d, w) {
  w = +(+w).toFixed(1);
  if (!ns) {
    const b = legacyBlob();
    b.entries = (b.entries || []).filter(e => e.d !== d).concat([{ d, w }]);
    if (b.startW == null && b.entries.length === 1) b.startW = w;
    jset(LEGACY, b);
  } else {
    jset(K('entries'), entries().filter(e => e.d !== d).concat([{ d, w }]));
    const t = tracker();
    if (t.startW == null && entries().length === 1) saveTracker({ startW: w }, { silent: true });
    enqueue({ t: 'up', d, w });
    scheduleFlush();
  }
  emit();
}

export function deleteEntry(d) {
  if (!ns) {
    const b = legacyBlob();
    b.entries = (b.entries || []).filter(e => e.d !== d);
    jset(LEGACY, b);
  } else {
    jset(K('entries'), entries().filter(e => e.d !== d));
    enqueue({ t: 'del', d });
    scheduleFlush();
  }
  emit();
}

export function saveTracker(patch, { silent } = {}) {
  if (!ns) {
    const b = legacyBlob();
    if ('goal' in patch) b.goal = patch.goal;
    if ('startW' in patch) b.startW = patch.startW;
    jset(LEGACY, b);
  } else {
    jset(K('tracker'), { ...tracker(), ...patch });
    enqueue({ t: 'tracker' });
    scheduleFlush();
  }
  if (!silent) emit();
}

export function setPhotoLocal(which, p) {
  if (!ns) {
    const key = which === 'before' ? LEGACY_PB : LEGACY_PA;
    if (p) jset(key, p); else localStorage.removeItem(key);
  } else {
    if (p) jset(K('photo:' + which), p); else localStorage.removeItem(K('photo:' + which));
  }
  emit();
}

// Save a photo: local cache immediately, cloud in the background.
export async function savePhoto(which, p) {
  setPhotoLocal(which, p);
  if (!ns || !cloud.user()) return;
  await cloud.uploadPhoto(which, p.img);
  const meta = { ...(tracker().photoMeta || {}) };
  meta[which] = { date: p.date, w: p.w };
  saveTracker({ photoMeta: meta }, { silent: true });
}

export async function removePhoto(which) {
  setPhotoLocal(which, null);
  if (!ns || !cloud.user()) return;
  await cloud.removePhotoRemote(which);
  const meta = { ...(tracker().photoMeta || {}) };
  delete meta[which];
  saveTracker({ photoMeta: meta }, { silent: true });
}

// ---- pull from cloud (server wins, except queued local ops) ----

export async function pullAll() {
  if (!ns || !cloud.user()) return;
  const [remoteEntries, remoteTracker] = await Promise.all([
    cloud.pullEntries(), cloud.pullTracker()
  ]);
  const ob = outbox();
  let ents = remoteEntries;
  for (const op of ob) {
    if (op.t === 'up') ents = ents.filter(e => e.d !== op.d).concat([{ d: op.d, w: op.w }]);
    if (op.t === 'del') ents = ents.filter(e => e.d !== op.d);
  }
  jset(K('entries'), ents);
  if (remoteTracker && !ob.some(o => o.t === 'tracker')) jset(K('tracker'), remoteTracker);
  emit();
  // Photos: fill the local cache from the cloud if we don't have them here.
  for (const which of ['before', 'after']) {
    if (!photo(which)) {
      const img = await cloud.downloadPhoto(which);
      if (img) {
        const meta = (remoteTracker?.photoMeta || {})[which] || {};
        setPhotoLocal(which, { img, date: meta.date || todayStr(), w: meta.w ?? null });
      }
    }
  }
}

// ---- legacy migration (device data -> account) ----

export function legacySnapshot() {
  const b = jget(LEGACY, null);
  if (!b || !Array.isArray(b.entries) || !b.entries.length) return null;
  return {
    data: b,
    photoBefore: jget(LEGACY_PB, null),
    photoAfter: jget(LEGACY_PA, null)
  };
}

export const migrationDone = () => ns && localStorage.getItem(K('migrated')) === '1';
export function dismissMigration() { if (ns) localStorage.setItem(K('migrated'), '1'); }

// Import a backup payload (the legacy snapshot and the exported JSON file
// share the same shape) into the signed-in account.
export async function importPayload(p) {
  if (!ns) throw new Error('Sign in first');
  const incoming = (p.data?.entries || [])
    .filter(e => e && typeof e.d === 'string' && isFinite(+e.w))
    .map(e => ({ d: e.d, w: +(+e.w).toFixed(1) }));
  if (!incoming.length && !p.photoBefore && !p.photoAfter) throw new Error('Nothing to import');

  // Merge into local mirror: imported wins on date clashes.
  const existing = entries().filter(x => !incoming.some(y => y.d === x.d));
  jset(K('entries'), existing.concat(incoming));
  const t = tracker();
  saveTracker({
    goal: p.data?.goal ?? t.goal ?? null,
    startW: p.data?.startW ?? t.startW ?? null
  }, { silent: true });

  // Push entries in bulk (one request), then queue is clean.
  await cloud.pushEntries(incoming);
  await cloud.pushTracker(tracker());

  for (const which of ['before', 'after']) {
    const ph = which === 'before' ? p.photoBefore : p.photoAfter;
    if (ph && ph.img) await savePhoto(which, { img: ph.img, date: ph.date || todayStr(), w: ph.w ?? null });
  }
  localStorage.setItem(K('migrated'), '1');
  emit();
  return incoming.length;
}

export function exportPayload() {
  const t = tracker();
  return {
    data: { entries: entries(), goal: t.goal ?? null, startW: t.startW ?? null },
    photoBefore: photo('before'),
    photoAfter: photo('after'),
    exported: new Date().toISOString()
  };
}

// keep data flowing when connectivity returns
window.addEventListener('online', () => { flush().catch(() => {}); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) flush().catch(() => {});
});
