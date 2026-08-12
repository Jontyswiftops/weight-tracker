// Me tab: sign in / account, display name, goal, backup, privacy notes.
import * as store from '../store.js';
import * as cloud from '../cloud.js';
import { G, esc, toast, showErr, hideErr } from '../util.js';

let profile = null;

async function loadProfile(ctx) {
  try {
    profile = await cloud.myProfile();
    ctx.rerender();
  } catch { /* offline is fine */ }
}

function goalCard(t) {
  return '<div class="card"><div class="cardtitle">Goal weight</div>' +
    '<input type="number" inputmode="decimal" step="0.1" id="goalInput" placeholder="e.g. 85" value="' + (t.goal ?? '') + '">' +
    '<button class="btn" id="goalBtn">Save goal</button>' +
    '<div class="note" id="startNote" style="display:none"></div></div>';
}

function backupCard() {
  return '<div class="card"><div class="cardtitle">Backup</div>' +
    '<button class="btn ghost" id="exportBtn" style="margin-top:0">Download my data</button>' +
    '<button class="btn ghost" id="importBtn">Restore from backup</button>' +
    '<input type="file" accept=".json,application/json" id="importFile" style="display:none">' +
    '<div class="note" id="backupNote"></div></div>';
}

export function render(ctx) {
  const el = G('meView');
  const t = store.tracker();
  const u = cloud.user();

  if (!u) {
    el.innerHTML =
      '<div class="card"><div class="cardtitle">Sign in</div>' +
      '<p class="note" style="margin-top:0">Back up your check-ins, sync across devices, and join group challenges. We email you a sign-in link. No password needed.</p>' +
      '<input type="email" id="authEmail" placeholder="you@email.com" autocomplete="email">' +
      '<button class="btn" id="magicBtn">Email me a sign-in link</button>' +
      '<div class="note" id="authStatus"></div>' +
      '<button class="linkbtn" id="pwToggle">Use a password instead</button>' +
      '<div id="pwBox" hidden>' +
      '<input type="password" id="authPw" placeholder="Password" autocomplete="current-password">' +
      '<div class="row" style="margin-top:10px"><button class="btn" id="pwSignIn" style="margin-top:0">Sign in</button>' +
      '<button class="btn ghost" id="pwSignUp" style="margin-top:0">Create account</button></div>' +
      '</div></div>' +
      goalCard(t) + backupCard();

    el.querySelector('#magicBtn').addEventListener('click', async e => {
      const email = el.querySelector('#authEmail').value.trim();
      const status = el.querySelector('#authStatus');
      if (!email || !email.includes('@')) { status.textContent = 'Enter your email address first.'; return; }
      e.target.disabled = true;
      const { error } = await cloud.sendMagicLink(email);
      e.target.disabled = false;
      status.textContent = error
        ? 'Could not send the link: ' + error.message
        : 'Check your email and tap the link to sign in. It can take a minute to arrive.';
    });
    el.querySelector('#pwToggle').addEventListener('click', () => {
      const box = el.querySelector('#pwBox');
      box.hidden = !box.hidden;
    });
    const pwAuth = async signUp => {
      const email = el.querySelector('#authEmail').value.trim();
      const pw = el.querySelector('#authPw').value;
      const status = el.querySelector('#authStatus');
      if (!email || !pw) { status.textContent = 'Enter your email and a password.'; return; }
      const { error } = signUp
        ? await cloud.signUpPassword(email, pw)
        : await cloud.signInPassword(email, pw);
      if (error) status.textContent = error.message;
      else if (signUp) status.textContent = 'Account created. Check your email if confirmation is required.';
    };
    el.querySelector('#pwSignIn').addEventListener('click', () => pwAuth(false));
    el.querySelector('#pwSignUp').addEventListener('click', () => pwAuth(true));
  } else {
    if (!profile) loadProfile(ctx);
    el.innerHTML =
      '<div class="card"><div class="cardtitle">Account</div>' +
      '<div class="note" style="margin-top:0">Signed in as ' + esc(u.email || '') + '</div>' +
      '<label class="flabel" for="nameInput">Display name (what your groups see)</label>' +
      '<div class="row"><input type="text" id="nameInput" maxlength="40" value="' + esc(profile?.display_name || '') + '">' +
      '<button class="btn small" id="nameBtn">Save</button></div>' +
      '<button class="linkbtn" id="signOutBtn">Sign out</button></div>' +
      goalCard(t) + backupCard() +
      '<div class="card"><div class="cardtitle">Privacy</div>' +
      '<div class="note" style="margin-top:0">Groups only ever see your percentage change, streak and last check-in date. Your actual weight stays private unless you switch on sharing inside a group. Photos are never shared.</div></div>';

    el.querySelector('#nameBtn').addEventListener('click', async () => {
      const name = el.querySelector('#nameInput').value.trim();
      if (!name) return;
      try {
        await cloud.saveDisplayName(name);
        profile = { ...(profile || {}), display_name: name };
        toast('Name saved');
      } catch (err) { showErr('Could not save your name: ' + err.message); }
    });
    el.querySelector('#signOutBtn').addEventListener('click', async () => {
      await cloud.signOut();
      profile = null;
    });
  }

  // shared: goal + backup
  const gi = el.querySelector('#goalInput');
  const startNote = el.querySelector('#startNote');
  const s = store.entries();
  const start = t.startW != null ? t.startW : (s.length ? s[0].w : null);
  if (start != null) {
    startNote.style.display = 'block';
    startNote.textContent = 'Progress is measured from your starting weight of ' + start.toFixed(1) + ' kg.';
  }
  el.querySelector('#goalBtn').addEventListener('click', () => {
    const g = parseFloat(gi.value);
    if (!g || g <= 0) return;
    const patch = { goal: g };
    if (t.startW == null) patch.startW = s.length ? s[0].w : null;
    store.saveTracker(patch);
    ctx.openTab('home');
  });

  el.querySelector('#backupNote').textContent = u
    ? 'Your data now syncs to your account. Backups are still handy for peace of mind, and Restore can import the old tracker’s file.'
    : 'Your data lives on this device. The Home Screen app and Safari each keep their own copy. Grab a backup now and then, and use Restore to move data between them or to a new phone.';

  el.querySelector('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(store.exportPayload(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'weight-tracker-backup.json';
    a.click();
  });
  el.querySelector('#importBtn').addEventListener('click', () => el.querySelector('#importFile').click());
  el.querySelector('#importFile').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = async ev => {
      try {
        const p = JSON.parse(ev.target.result);
        if (!p.data || !Array.isArray(p.data.entries)) throw new Error('bad');
        if (cloud.user()) {
          const n = await store.importPayload(p);
          toast('Backup restored: ' + n + ' check-in' + (n === 1 ? '' : 's') + ' imported');
        } else {
          // signed out: merge into the on-device data, old-app style
          p.data.entries.forEach(en => store.saveEntry(en.d, en.w));
          store.saveTracker({
            goal: p.data.goal ?? store.tracker().goal,
            startW: p.data.startW ?? store.tracker().startW
          });
          if (p.photoBefore) store.setPhotoLocal('before', p.photoBefore);
          if (p.photoAfter) store.setPhotoLocal('after', p.photoAfter);
          toast('Backup restored: ' + p.data.entries.length + ' check-ins imported');
        }
        hideErr();
        ctx.rerender();
      } catch {
        showErr('That file does not look like a valid backup.');
      }
    };
    r.readAsText(f);
    e.target.value = '';
  });
}

export function resetProfile() { profile = null; }
