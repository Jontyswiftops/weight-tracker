// Groups tab: list + create + join, and the group screen with the
// percentage leaderboard, share-weight toggle and activity feed.
import * as store from '../store.js';
import * as cloud from '../cloud.js';
import { G, esc, fmtDate, toast, showErr, hideErr } from '../util.js';

let groups = [];          // cached myGroups()
let openId = null;        // group currently open, or null for the list
let board = null;         // leaderboard rows for the open group
let feed = null;          // feed rows for the open group
let unsub = null;         // realtime unsubscribe for the open group
let loading = false;

export const groupIds = () => groups.map(g => g.id);

export async function refresh(ctx) {
  if (!cloud.user()) { groups = []; return; }
  try {
    groups = await cloud.myGroups();
    // stay subscribed to every group so check-in pings reach members live
    groups.forEach(g => cloud.subscribeGroup(g.id));
    if (ctx) ctx.rerender();
  } catch { /* offline: keep the old cache */ }
}

async function loadDetail(ctx) {
  if (!openId || !cloud.user()) return;
  loading = true;
  try {
    const [b, f] = await Promise.all([cloud.leaderboard(openId), cloud.groupFeed(openId)]);
    board = b; feed = f;
    hideErr();
  } catch (err) {
    showErr('Could not load the group: ' + (err.message || 'check your connection.'));
  }
  loading = false;
  ctx.rerender();
}

export function openGroup(gid, ctx) {
  openId = gid;
  board = feed = null;
  if (unsub) unsub();
  unsub = cloud.subscribeGroup(gid, () => loadDetail(ctx));
  loadDetail(ctx);
  ctx.openTab('groups');
}

function closeGroup(ctx) {
  openId = null;
  board = feed = null;
  if (unsub) { unsub(); unsub = null; }
  ctx.rerender();
}

const inviteLink = code => location.origin + location.pathname + '#join=' + code;

function pctBadge(p) {
  if (p == null) return '<div class="lbpct neutral">--</div>';
  const cls = p < 0 ? 'good' : (p > 0 ? 'bad' : 'neutral');
  const txt = (p > 0 ? '+' : '') + p.toFixed(1) + '%';
  return '<div class="lbpct ' + cls + '">' + txt + '</div>';
}

function renderDetail(el, ctx) {
  const g = groups.find(x => x.id === openId);
  if (!g) { closeGroup(ctx); return; }
  const me = (board || []).find(r => r.is_self);
  const ends = g.ends_on ? 'Ends ' + fmtDate(g.ends_on) : 'No end date';

  let html = '<button class="linkbtn" id="backBtn">&lsaquo; All groups</button>' +
    '<div class="card"><div class="cardtitle">' + esc(g.name) + '</div>' +
    '<div class="note" style="margin-top:0">' + ends + ' · ' + (g.group_members?.length || 1) + ' member' + ((g.group_members?.length || 1) === 1 ? '' : 's') + '</div>' +
    '<div style="margin-top:10px" class="row"><span class="codechip">' + esc(g.invite_code) + '</span>' +
    '<button class="btn small ghost" id="shareBtn">Share invite</button></div></div>';

  html += '<div class="card"><div class="cardtitle">Leaderboard · % of body weight</div>';
  if (loading && !board) html += '<div class="note" style="margin-top:0">Loading...</div>';
  else if (!board || !board.length) html += '<div class="note" style="margin-top:0">No members yet.</div>';
  else {
    html += board.map((r, i) => {
      const kg = r.weight_kg != null ? ' · ' + r.weight_kg.toFixed(1) + ' kg' : '';
      const sub = r.last_checkin
        ? '🔥 ' + r.streak + ' day streak · last check-in ' + fmtDate(r.last_checkin) + kg
        : 'No check-ins yet';
      return '<div class="lbrow' + (r.is_self ? ' me' : '') + '">' +
        '<div class="lbrank">' + (i + 1) + '</div>' +
        '<div class="lbmain"><div class="lbname">' + esc(r.display_name) + (r.is_self ? ' (you)' : '') + '</div>' +
        '<div class="lbsub">' + sub + '</div></div>' +
        pctBadge(r.pct_change) + '</div>';
    }).join('');
  }
  html += '</div>';

  html += '<div class="card"><div class="switchrow">' +
    '<div><div class="swlabel">Share my actual weight</div>' +
    '<div class="swnote">Only with this group. Off means they see percentage only.</div></div>' +
    '<label class="switch"><input type="checkbox" id="shareW"' + (me?.share_weight ? ' checked' : '') + '>' +
    '<span class="slider"></span></label></div></div>';

  html += '<div class="card"><div class="cardtitle">Activity</div>';
  if (loading && !feed) html += '<div class="note" style="margin-top:0">Loading...</div>';
  else if (!feed || !feed.length) html += '<div class="note" style="margin-top:0">No check-ins yet. Be the first!</div>';
  else {
    html += feed.map(f =>
      '<div class="feeditem"><b>' + esc(f.display_name) + '</b> checked in' +
      (f.streak > 1 ? ' · ' + f.streak + ' day streak' : '') +
      '<small>' + fmtDate(f.d) + '</small></div>'
    ).join('');
  }
  html += '</div>';

  html += '<button class="linkbtn danger" id="leaveBtn">Leave this group</button>';

  el.innerHTML = html;
  el.querySelector('#backBtn').addEventListener('click', () => closeGroup(ctx));
  el.querySelector('#shareBtn').addEventListener('click', async () => {
    const url = inviteLink(g.invite_code);
    const text = 'Join my group "' + g.name + '" on Weight Check-in. Code: ' + g.invite_code;
    if (navigator.share) {
      try { await navigator.share({ title: 'Weight Check-in', text, url }); } catch {}
    } else {
      try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
      catch { toast('Invite code: ' + g.invite_code); }
    }
  });
  el.querySelector('#shareW').addEventListener('change', async e => {
    try {
      await cloud.setShareWeight(g.id, e.target.checked);
      toast(e.target.checked ? 'Your weight is visible to this group' : 'Your weight is hidden again');
      loadDetail(ctx);
    } catch (err) {
      e.target.checked = !e.target.checked;
      showErr('Could not update sharing: ' + err.message);
    }
  });
  el.querySelector('#leaveBtn').addEventListener('click', async () => {
    if (!confirm('Leave "' + g.name + '"? You can rejoin later with the invite code.')) return;
    try {
      await cloud.leaveGroup(g.id);
      toast('Left ' + g.name);
      closeGroup(ctx);
      refresh(ctx);
    } catch (err) { showErr('Could not leave: ' + err.message); }
  });
}

function renderList(el, ctx) {
  let html = '';
  if (groups.length) {
    html += groups.map(g => {
      const n = g.group_members?.length || 1;
      const ends = g.ends_on ? ' · ends ' + fmtDate(g.ends_on) : '';
      return '<div class="gitem" data-g="' + g.id + '">' +
        '<div class="gname">' + esc(g.name) + '<small>' + n + ' member' + (n === 1 ? '' : 's') + ends + '</small></div>' +
        '<div class="gchev">&rsaquo;</div></div>';
    }).join('');
  } else {
    html += '<div class="empty" style="margin-top:0">Create a group and share the invite link, or join a mate\'s group with their code. The leaderboard tracks percentage lost, so it\'s fair no matter your size, and nobody sees your actual weight.</div>';
  }

  html += '<div class="card" style="margin-top:14px"><div class="cardtitle">Start a group</div>' +
    '<input type="text" id="grpName" placeholder="Group name" maxlength="60">' +
    '<label class="flabel" for="grpEnds">End date (optional)</label>' +
    '<input type="date" id="grpEnds">' +
    '<button class="btn" id="grpCreate">Create group</button></div>';

  html += '<div class="card"><div class="cardtitle">Join with a code</div>' +
    '<div class="row"><input type="text" id="joinCode" placeholder="e.g. K7M2PQ" maxlength="6" autocapitalize="characters" style="text-transform:uppercase">' +
    '<button class="btn small" id="joinBtn">Join</button></div></div>';

  el.innerHTML = html;

  el.querySelectorAll('[data-g]').forEach(d =>
    d.addEventListener('click', () => openGroup(d.dataset.g, ctx)));

  el.querySelector('#grpCreate').addEventListener('click', async e => {
    const name = el.querySelector('#grpName').value.trim();
    const ends = el.querySelector('#grpEnds').value || null;
    if (!name) { showErr('Give your group a name first.'); return; }
    e.target.disabled = true;
    try {
      const g = await cloud.createGroup(name, ends);
      hideErr();
      toast('Group created');
      await refresh();
      openGroup(g.id, ctx);
    } catch (err) {
      showErr('Could not create the group: ' + err.message);
      e.target.disabled = false;
    }
  });

  el.querySelector('#joinBtn').addEventListener('click', () =>
    joinWithCode(el.querySelector('#joinCode').value, ctx));
}

export async function joinWithCode(code, ctx) {
  code = (code || '').trim().toUpperCase();
  if (!code) return;
  try {
    const g = await cloud.joinGroup(code);
    hideErr();
    toast('Welcome to ' + g.name);
    await refresh();
    openGroup(g.id, ctx);
  } catch (err) {
    showErr(err.message || 'Could not join with that code.');
  }
}

export function render(ctx) {
  const el = G('groupsView');
  if (!cloud.user()) {
    openId = null;
    el.innerHTML = '<div class="empty" style="margin-top:0"><b>Group challenges</b><br>' +
      'Create a competition, invite your mates, and keep each other accountable. ' +
      'The leaderboard ranks percentage lost, never your actual weight.<br><br>' +
      '<button class="btn small" id="grpSignIn">Sign in to get started</button></div>';
    el.querySelector('#grpSignIn').addEventListener('click', () => ctx.openTab('me'));
    return;
  }
  if (openId) renderDetail(el, ctx);
  else renderList(el, ctx);
}
