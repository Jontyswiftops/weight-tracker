// App bootstrap: tabs, auth lifecycle, sync, invite links, service worker.
import * as store from './store.js';
import * as cloud from './cloud.js';
import { G, toast } from './util.js';
import * as today from './views/today.js';
import * as history from './views/history.js';
import * as groupsView from './views/groups.js';
import * as photos from './views/photos.js';
import * as me from './views/me.js';

const PENDING_JOIN = 'wt2:pendingJoin';
let page = 'home';
let lastUid = null;

const ctx = {
  rerender: render,
  openTab,
  // After a check-in lands, push it and nudge every group to refresh.
  afterCheckin() {
    store.flush()
      .then(() => groupsView.groupIds().forEach(id => cloud.pingGroup(id)))
      .catch(() => {});
  }
};

function openTab(name) {
  page = name;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.page === name));
  document.querySelectorAll('.page').forEach(p =>
    p.classList.toggle('active', p.id === 'page-' + name));
  render();
}

function render() {
  today.render(ctx); // header lives on every tab
  if (page === 'history') history.render(ctx);
  else if (page === 'groups') groupsView.render(ctx);
  else if (page === 'photos') photos.render(ctx);
  else if (page === 'me') me.render(ctx);
}

// ---- invite links (#join=CODE) ----

function captureJoinHash() {
  const m = (location.hash || '').match(/join=([A-Za-z0-9]{4,12})/i);
  if (m) {
    localStorage.setItem(PENDING_JOIN, m[1].toUpperCase());
    history_replace();
  }
}
function history_replace() {
  try { window.history.replaceState(null, '', location.pathname + location.search); } catch {}
}

function processPendingJoin() {
  const code = localStorage.getItem(PENDING_JOIN);
  if (!code) return;
  if (cloud.user()) {
    localStorage.removeItem(PENDING_JOIN);
    groupsView.joinWithCode(code, ctx);
  } else {
    openTab('me');
    toast('Sign in to join the group you were invited to');
  }
}

// ---- auth lifecycle ----

function onSignedIn(uid) {
  if (uid === lastUid) return;
  lastUid = uid;
  store.setUser(uid);
  me.resetProfile();
  groupsView.loadCache();
  store.flush()
    .then(() => store.pullAll())
    .then(render)
    .catch(() => {});
  groupsView.refresh(ctx);
  processPendingJoin();
  render();
}

// Catch up after the auth token refreshes or the app returns to the
// foreground; a cold morning start can race the token refresh and leave
// stale or missing data on screen otherwise.
function resync() {
  if (!cloud.user()) return;
  store.flush()
    .then(() => store.pullAll())
    .then(render)
    .catch(() => {});
  groupsView.refresh(ctx, { throttle: true });
}

function onSignedOut() {
  lastUid = null;
  store.setUser(null);
  me.resetProfile();
  cloud.teardownChannels();
  render();
}

// ---- boot ----

async function boot() {
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => openTab(t.dataset.page)));

  today.init(ctx);
  photos.init(ctx);
  store.onChange(() => {});

  captureJoinHash();
  window.addEventListener('hashchange', () => { captureJoinHash(); processPendingJoin(); });

  await cloud.ready;
  cloud.onAuth(event => {
    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'USER_UPDATED') {
      const u = cloud.user();
      if (u) onSignedIn(u.id);
    } else if (event === 'TOKEN_REFRESHED') {
      resync();
    } else if (event === 'SIGNED_OUT') {
      onSignedOut();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resync();
  });

  const u = cloud.user();
  if (u) onSignedIn(u.id);
  else {
    store.setUser(null);
    render();
    if (localStorage.getItem(PENDING_JOIN)) processPendingJoin();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
