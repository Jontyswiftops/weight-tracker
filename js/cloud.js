// Supabase client, auth, and all remote API calls.
// window.supabase comes from vendor/supabase.js.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { todayStr } from './util.js';

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let session = null;
const authCbs = new Set();

export const ready = sb.auth.getSession().then(({ data }) => { session = data.session; });

sb.auth.onAuthStateChange((event, s) => {
  session = s;
  authCbs.forEach(cb => cb(event, s));
});

export const user = () => session?.user ?? null;

// cb(event, session); returns unsubscribe.
export function onAuth(cb) {
  authCbs.add(cb);
  return () => authCbs.delete(cb);
}

const appUrl = () => location.origin + location.pathname;

export const sendMagicLink = email =>
  sb.auth.signInWithOtp({ email, options: { emailRedirectTo: appUrl() } });

export const signInPassword = (email, password) =>
  sb.auth.signInWithPassword({ email, password });

// The 6-digit code from the sign-in email; lets iOS Home Screen users sign
// in without leaving the app (magic links always open in Safari instead).
export const verifyEmailCode = (email, token) =>
  sb.auth.verifyOtp({ email, token: token.trim(), type: 'email' });

export const setPassword = password =>
  sb.auth.updateUser({ password });

export const signUpPassword = (email, password) =>
  sb.auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } });

export const signOut = () => sb.auth.signOut();

// ---- profile ----

export async function myProfile() {
  const u = user();
  if (!u) return null;
  const { data, error } = await sb.from('profiles').select('*').eq('id', u.id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveDisplayName(name) {
  const { error } = await sb.from('profiles')
    .update({ display_name: name }).eq('id', user().id);
  if (error) throw error;
}

// ---- entries ----

export async function pullEntries() {
  const { data, error } = await sb.from('entries').select('d, w').order('d');
  if (error) throw error;
  return data.map(r => ({ d: r.d, w: Number(r.w) }));
}

export async function pushEntries(rows) {
  if (!rows.length) return;
  const uid = user().id;
  const { error } = await sb.from('entries')
    .upsert(rows.map(r => ({ user_id: uid, d: r.d, w: r.w })));
  if (error) throw error;
}

export async function deleteEntryRemote(d) {
  const { error } = await sb.from('entries')
    .delete().eq('user_id', user().id).eq('d', d);
  if (error) throw error;
}

// ---- tracker (goal, starting weight, photo metadata) ----

export async function pullTracker() {
  const { data, error } = await sb.from('tracker').select('*')
    .eq('user_id', user().id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    goal: data.goal_kg != null ? Number(data.goal_kg) : null,
    startW: data.start_w != null ? Number(data.start_w) : null,
    photoMeta: data.photo_meta || null
  };
}

export async function pushTracker(t) {
  const row = { user_id: user().id };
  if ('goal' in t) row.goal_kg = t.goal;
  if ('startW' in t) row.start_w = t.startW;
  if ('photoMeta' in t) row.photo_meta = t.photoMeta;
  const { error } = await sb.from('tracker').upsert(row);
  if (error) throw error;
}

// ---- photos (private bucket, one before + one after per user) ----

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export async function uploadPhoto(which, dataUrl) {
  const path = user().id + '/' + which + '.jpg';
  // cacheControl '0': private photos must never sit in a shared browser's
  // HTTP cache where another account on the same device could see them.
  const { error } = await sb.storage.from('photos')
    .upload(path, dataUrlToBlob(dataUrl), { upsert: true, contentType: 'image/jpeg', cacheControl: '0' });
  if (error) throw error;
}

export async function downloadPhoto(which) {
  const path = user().id + '/' + which + '.jpg';
  const { data, error } = await sb.storage.from('photos').download(path);
  if (error) return null; // not found is fine
  return await new Promise(res => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(data);
  });
}

export async function removePhotoRemote(which) {
  await sb.storage.from('photos').remove([user().id + '/' + which + '.jpg']).catch(() => {});
}

// ---- groups ----

export async function myGroups() {
  const { data, error } = await sb.from('groups')
    .select('id, name, ends_on, invite_code, created_by, created_at, group_members(user_id)')
    .order('created_at');
  if (error) throw error;
  return data;
}

export async function updateGroup(gid, patch) {
  const { error } = await sb.from('groups').update(patch).eq('id', gid);
  if (error) throw error;
}

export async function removeMember(gid, uid) {
  const { error } = await sb.from('group_members')
    .delete().eq('group_id', gid).eq('user_id', uid);
  if (error) throw error;
}

export async function memberHistory(gid, member) {
  const { data, error } = await sb.rpc('member_history', { gid, member });
  if (error) throw error;
  return data.map(r => ({ d: r.d, w: Number(r.w) }));
}

export async function createGroup(name, endsOn) {
  const { data, error } = await sb.rpc('create_group', {
    group_name: name, group_ends_on: endsOn || null
  });
  if (error) throw error;
  return data;
}

export async function joinGroup(code) {
  const { data, error } = await sb.rpc('join_group', { code });
  if (error) throw error;
  return data;
}

export async function leaveGroup(gid) {
  const { error } = await sb.from('group_members')
    .delete().eq('group_id', gid).eq('user_id', user().id);
  if (error) throw error;
}

export async function leaderboard(gid) {
  const { data, error } = await sb.rpc('group_leaderboard', { gid, p_today: todayStr() });
  if (error) throw error;
  return data.map(r => ({
    ...r,
    pct_change: r.pct_change != null ? Number(r.pct_change) : null,
    weight_kg: r.weight_kg != null ? Number(r.weight_kg) : null,
    baseline_kg: r.baseline_kg != null ? Number(r.baseline_kg) : null
  }));
}

export async function groupFeed(gid) {
  const { data, error } = await sb.rpc('group_feed', { gid, p_today: todayStr() });
  if (error) throw error;
  return data;
}

// fields: { share_weight?, share_history? }
export async function setSharing(gid, fields) {
  const { error } = await sb.from('group_members')
    .update(fields)
    .eq('group_id', gid).eq('user_id', user().id);
  if (error) throw error;
}

// ---- realtime: one broadcast channel per group ----
// Pings carry no data; receivers refetch via the RPCs, which enforce access.

const channels = new Map(); // gid -> { ch, cbs }

export function subscribeGroup(gid, cb) {
  let c = channels.get(gid);
  if (!c) {
    const ch = sb.channel('grp-' + gid);
    c = { ch, cbs: new Set() };
    ch.on('broadcast', { event: 'checkin' }, () => c.cbs.forEach(f => { try { f(); } catch {} }));
    ch.subscribe();
    channels.set(gid, c);
  }
  if (cb) c.cbs.add(cb);
  return () => { if (cb) c.cbs.delete(cb); };
}

export function pingGroup(gid) {
  const c = channels.get(gid);
  if (c) {
    try { c.ch.send({ type: 'broadcast', event: 'checkin', payload: {} }); } catch {}
  }
}

export function teardownChannels() {
  channels.forEach(c => { try { sb.removeChannel(c.ch); } catch {} });
  channels.clear();
}
