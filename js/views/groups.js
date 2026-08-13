// Groups tab: list + create + join, the group screen (percentage
// leaderboard, sharing toggles, activity feed, owner tools), and the
// shared member trend/history view.
import * as store from '../store.js';
import * as cloud from '../cloud.js';
import { G, esc, fmtDate, signed, cls, toast, showErr, hideErr } from '../util.js';
import { renderChart } from '../chart.js';

let groups = [];          // cached myGroups()
let openId = null;        // group currently open, or null for the list
let board = null;         // leaderboard rows for the open group
let feed = null;          // feed rows for the open group
let unsub = null;         // realtime unsubscribe for the open group
let loading = false;
let editMode = false;     // owner edit panel visible
let member = null;        // { uid, name, entries } when viewing a member's trend

export const groupIds = () => groups.map(g => g.id);

// The list is cached on-device so a failed fetch (expired token on a cold
// morning start, flaky radio) never renders an empty Groups tab that looks
// like being kicked out. Fetches retry whenever the tab is viewed.
let lastFetch = 0;
const cacheKey = () => 'wt2:' + (cloud.user()?.id || 'none') + ':groups';

export function loadCache() {
  if (!cloud.user()) { groups = []; return; }
  try { groups = JSON.parse(localStorage.getItem(cacheKey())) || []; }
  catch { groups = []; }
  groups.forEach(g => cloud.subscribeGroup(g.id));
}

export async function refresh(ctx, { throttle = false } = {}) {
  if (!cloud.user()) { groups = []; return; }
  if (throttle && Date.now() - lastFetch < 15000) return;
  try {
    groups = await cloud.myGroups();
    lastFetch = Date.now();
    try { localStorage.setItem(cacheKey(), JSON.stringify(groups)); } catch {}
    // stay subscribed to every group so check-in pings reach members live
    groups.forEach(g => cloud.subscribeGroup(g.id));
    if (ctx) ctx.rerender();
  } catch { /* offline or token mid-refresh: keep the cached list */ }
}

async function loadDetail(ctx) {
  if (!openId || !cloud.user()) return;
  loading = true;
  try {
    const [b, f] = await Promise.all([cloud.leaderboard(openId), cloud.groupFeed(openId)]);
    board = b; feed = f;
    hideErr();
  } catch (err) {
    if (/not a member/i.test(err.message || '')) {
      // kicked or group gone: fall back to the list
      closeGroup(ctx);
      refresh(ctx);
      return;
    }
    showErr('Could not load the group: ' + (err.message || 'check your connection.'));
  }
  loading = false;
  ctx.rerender();
}

export function openGroup(gid, ctx) {
  openId = gid;
  board = feed = null;
  editMode = false;
  member = null;
  if (unsub) unsub();
  unsub = cloud.subscribeGroup(gid, () => loadDetail(ctx));
  loadDetail(ctx);
  ctx.openTab('groups');
  window.scrollTo(0, 0);
}

function closeGroup(ctx) {
  openId = null;
  board = feed = null;
  editMode = false;
  member = null;
  if (unsub) { unsub(); unsub = null; }
  ctx.rerender();
  window.scrollTo(0, 0);
}

const inviteLink = code => location.origin + location.pathname + '#join=' + code;

function pctBadge(p) {
  if (p == null) return '<div class="lbpct neutral">--</div>';
  const c = p < 0 ? 'good' : (p > 0 ? 'bad' : 'neutral');
  return '<div class="lbpct ' + c + '">' + (p > 0 ? '+' : '') + p.toFixed(1) + '%</div>';
}

async function openMember(row, ctx) {
  try {
    const entries = await cloud.memberHistory(openId, row.user_id);
    member = { uid: row.user_id, name: row.display_name, isSelf: row.is_self, entries };
    hideErr();
    ctx.rerender();
    window.scrollTo(0, 0);
  } catch (err) {
    showErr(err.message || 'Could not load their history.');
  }
}

function renderMember(el, ctx) {
  const m = member;
  let html = '<button class="linkbtn" id="memberBack">&lsaquo; Back to group</button>' +
    '<div class="card chartcard"><div class="cardtitle" style="margin-left:6px">' +
    esc(m.name) + (m.isSelf ? ' (you)' : '') + ' · trend</div>' +
    '<canvas id="memberChart" height="220"></canvas>' +
    '<div class="legend" id="memberLegend"><span><b style="color:var(--green)">&#8212;</b> 7-day average</span><span>&middot; daily weigh-ins</span></div></div>';

  if (m.entries.length) {
    const rev = [...m.entries].reverse();
    html += '<div style="margin-top:14px">' + rev.map((e, i) => {
      const prev = rev[i + 1];
      const diff = prev ? e.w - prev.w : null;
      return '<div class="hitem">' +
        '<div class="hdate">' + fmtDate(e.d) + ' <small>' + e.d.slice(0, 4) + '</small></div>' +
        '<div class="hweight">' + e.w.toFixed(1) + ' kg</div>' +
        (diff != null ? '<div class="hdiff ' + cls(diff) + '">' + signed(diff, '') + '</div>' : '<div class="hdiff"></div>') +
        '</div>';
    }).join('') + '</div>';
  } else {
    html += '<div class="empty">No check-ins since joining yet.</div>';
  }

  el.innerHTML = html;
  el.querySelector('#memberBack').addEventListener('click', () => { member = null; ctx.rerender(); window.scrollTo(0, 0); });
  const drawn = renderChart(el.querySelector('#memberChart'), m.entries, null);
  if (!drawn) {
    el.querySelector('.chartcard').querySelector('canvas').style.display = 'none';
    el.querySelector('#memberLegend').innerHTML = '<span>The chart appears once there are a couple of check-ins.</span>';
  }
}

function editHtml(g) {
  const others = (board || []).filter(r => !r.is_self);
  let html = '<div class="card" id="editPanel"><div class="cardtitle">Edit group</div>' +
    '<label class="flabel" for="editName">Group name</label>' +
    '<input type="text" id="editName" maxlength="60" value="' + esc(g.name) + '">' +
    '<label class="flabel" for="editEnds">End date (leave empty for no end date)</label>' +
    '<input type="date" id="editEnds" value="' + (g.ends_on || '') + '">' +
    '<div class="row" style="margin-top:10px"><button class="btn" id="editSave" style="margin-top:0">Save</button>' +
    '<button class="btn ghost" id="editCancel" style="margin-top:0">Cancel</button></div>';
  if (others.length) {
    html += '<label class="flabel" style="margin-top:16px">Members</label>' +
      others.map(r =>
        '<div class="hitem" style="margin-bottom:6px"><div class="hdate">' + esc(r.display_name) + '</div>' +
        '<button class="xbtn" data-kick="' + r.user_id + '" data-kickname="' + esc(r.display_name) + '" aria-label="Remove">✕</button></div>'
      ).join('');
  }
  return html + '</div>';
}

function wireEdit(el, g, ctx) {
  el.querySelector('#editCancel').addEventListener('click', () => { editMode = false; ctx.rerender(); });
  el.querySelector('#editSave').addEventListener('click', async e => {
    const name = el.querySelector('#editName').value.trim();
    const ends = el.querySelector('#editEnds').value || null;
    if (!name) { showErr('The group needs a name.'); return; }
    e.target.disabled = true;
    try {
      await cloud.updateGroup(g.id, { name, ends_on: ends });
      hideErr();
      toast('Group updated');
      editMode = false;
      await refresh();
      loadDetail(ctx);
    } catch (err) {
      showErr('Could not save: ' + err.message);
      e.target.disabled = false;
    }
  });
  el.querySelectorAll('[data-kick]').forEach(b => b.addEventListener('click', async () => {
    const name = b.dataset.kickname;
    if (!confirm('Remove ' + name + ' from the group? They can rejoin with the invite code.')) return;
    try {
      await cloud.removeMember(g.id, b.dataset.kick);
      toast('Removed ' + name);
      await refresh();
      loadDetail(ctx);
    } catch (err) { showErr('Could not remove them: ' + err.message); }
  }));
}

function renderDetail(el, ctx) {
  const g = groups.find(x => x.id === openId);
  if (!g) { closeGroup(ctx); return; }
  const me = (board || []).find(r => r.is_self);
  const isOwner = g.created_by === cloud.user()?.id;
  const ends = g.ends_on ? 'Ends ' + fmtDate(g.ends_on) : 'No end date';
  const n = g.group_members?.length || 1;

  let html = '<button class="linkbtn" id="backBtn">&lsaquo; All groups</button>' +
    '<div class="card"><div class="cardtitle">' + esc(g.name) + '</div>' +
    '<div class="note" style="margin-top:0">' + ends + ' · ' + n + ' member' + (n === 1 ? '' : 's') + '</div>' +
    '<div style="margin-top:10px" class="row"><span class="codechip">' + esc(g.invite_code) + '</span>' +
    '<button class="btn small ghost" id="shareBtn">Share invite</button>' +
    (isOwner ? '<button class="btn small ghost" id="editBtn">' + (editMode ? 'Close' : 'Edit') + '</button>' : '') +
    '</div></div>';

  // Edit panel sits right under the group card so it is visible the moment
  // the Edit button is tapped (it used to render below the fold).
  if (editMode) html += editHtml(g);

  html += '<div class="card"><div class="cardtitle">Leaderboard · % of body weight</div>';
  if (loading && !board) html += '<div class="note" style="margin-top:0">Loading...</div>';
  else if (!board || !board.length) html += '<div class="note" style="margin-top:0">No members yet.</div>';
  else {
    html += board.map((r, i) => {
      const kg = r.weight_kg != null ? ' · ' + r.weight_kg.toFixed(1) + ' kg' : '';
      const sub = r.last_checkin
        ? '🔥 ' + r.streak + ' day streak · last check-in ' + fmtDate(r.last_checkin) + kg
        : 'No check-ins yet';
      const tappable = r.is_self || r.share_history;
      return '<div class="lbrow' + (r.is_self ? ' me' : '') + (tappable ? ' tap" data-member="' + i : '') + '">' +
        '<div class="lbrank">' + (i + 1) + '</div>' +
        '<div class="lbmain"><div class="lbname">' + esc(r.display_name) + (r.is_self ? ' (you)' : '') + '</div>' +
        '<div class="lbsub">' + sub + '</div></div>' +
        pctBadge(r.pct_change) +
        (tappable ? '<div class="gchev">&rsaquo;</div>' : '') + '</div>';
    }).join('');
    html += '<div class="note">Tap a member to see their trend, if they share it.</div>';
  }
  html += '</div>';

  html += '<div class="card">' +
    '<div class="switchrow"><div><div class="swlabel">Share my actual weight</div>' +
    '<div class="swnote">Shows your kg on this leaderboard. Off means percentage only.</div></div>' +
    '<label class="switch"><input type="checkbox" id="shareW"' + (me?.share_weight ? ' checked' : '') + '>' +
    '<span class="slider"></span></label></div>' +
    '<div class="switchrow" style="margin-top:14px"><div><div class="swlabel">Share my history and trend</div>' +
    '<div class="swnote">Lets this group open your chart and weigh-ins since joining. Turns on weight sharing too.</div></div>' +
    '<label class="switch"><input type="checkbox" id="shareH"' + (me?.share_history ? ' checked' : '') + '>' +
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
  if (editMode) wireEdit(el, g, ctx);

  el.querySelector('#backBtn').addEventListener('click', () => closeGroup(ctx));
  if (isOwner) el.querySelector('#editBtn').addEventListener('click', () => {
    editMode = !editMode;
    ctx.rerender();
    if (editMode) {
      document.getElementById('editPanel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
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
  el.querySelectorAll('[data-member]').forEach(d => d.addEventListener('click', () =>
    openMember(board[+d.dataset.member], ctx)));

  const applySharing = async (input, fields, onMsg, offMsg) => {
    try {
      await cloud.setSharing(g.id, fields);
      toast(input.checked ? onMsg : offMsg);
      loadDetail(ctx);
    } catch (err) {
      input.checked = !input.checked;
      showErr('Could not update sharing: ' + err.message);
    }
  };
  el.querySelector('#shareW').addEventListener('change', e => {
    const on = e.target.checked;
    if (!on) el.querySelector('#shareH').checked = false;
    applySharing(e.target,
      on ? { share_weight: true } : { share_weight: false, share_history: false },
      'Your weight is visible to this group', 'Your weight is hidden again');
  });
  el.querySelector('#shareH').addEventListener('change', e => {
    const on = e.target.checked;
    if (on) el.querySelector('#shareW').checked = true;
    applySharing(e.target,
      on ? { share_weight: true, share_history: true } : { share_history: false },
      'Your history is visible to this group', 'Your history is hidden again');
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
  // self-heal: any view of this tab refetches (throttled), so a failed
  // startup fetch fixes itself instead of showing an empty list
  refresh(ctx, { throttle: true });
  if (!cloud.user()) {
    openId = null;
    member = null;
    el.innerHTML = '<div class="empty" style="margin-top:0"><b>Group challenges</b><br>' +
      'Create a competition, invite your mates, and keep each other accountable. ' +
      'The leaderboard ranks percentage lost, never your actual weight.<br><br>' +
      '<button class="btn small" id="grpSignIn">Sign in to get started</button></div>';
    el.querySelector('#grpSignIn').addEventListener('click', () => ctx.openTab('me'));
    return;
  }
  if (openId && member) renderMember(el, ctx);
  else if (openId) renderDetail(el, ctx);
  else renderList(el, ctx);
}
