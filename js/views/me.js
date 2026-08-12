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
      '<p class="note" style="margin-top:0">Back up your check-ins, sync across devices, and join group challenges. We email you a sign-in code. No password needed.</p>' +
      '<input type="email" id="authEmail" placeholder="you@email.com" autocomplete="email">' +
      '<button class="btn" id="magicBtn">Email me a sign-in code</button>' +
      '<div class="note" id="authStatus"></div>' +
      '<div id="otpBox" hidden>' +
      '<label class="flabel" for="otpInput">6-digit code from the email</label>' +
      '<div class="row"><input type="text" id="otpInput" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">' +
      '<button class="btn small" id="otpBtn">Verify</button></div>' +
      '</div>' +
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
      if (error) {
        status.textContent = 'Could not send the email: ' + error.message;
      } else {
        status.textContent = 'Check your email, then type the 6-digit code below. It can take a minute to arrive.';
        el.querySelector('#otpBox').hidden = false;
        el.querySelector('#otpInput').focus();
      }
    });
    el.querySelector('#otpBtn').addEventListener('click', async e => {
      const email = el.querySelector('#authEmail').value.trim();
      const token = el.querySelector('#otpInput').value.trim();
      const status = el.querySelector('#authStatus');
      if (token.length < 6) { status.textContent = 'Enter the 6-digit code from the email.'; return; }
      e.target.disabled = true;
      const { error } = await cloud.verifyEmailCode(email, token);
      e.target.disabled = false;
      if (error) status.textContent = 'That code did not work: ' + error.message + ' Codes expire after a while; you can request a new one.';
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
      if (error) {
        status.textContent = /invalid login credentials/i.test(error.message)
          ? 'That email and password do not match. If you normally sign in with an emailed code, your account has no password yet: sign in with a code, then set a password from the Me tab.'
          : error.message;
      } else if (signUp) {
        status.textContent = 'Account created. Check your email if confirmation is required.';
      }
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
      '<label class="flabel" for="setPwInput">Set a password (optional, lets you sign in without email codes)</label>' +
      '<div class="row"><input type="password" id="setPwInput" autocomplete="new-password" placeholder="New password">' +
      '<button class="btn small" id="setPwBtn">Set</button></div>' +
      '<div class="note" id="setPwStatus" style="margin-top:6px"></div>' +
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
    el.querySelector('#setPwBtn').addEventListener('click', async e => {
      const pw = el.querySelector('#setPwInput').value;
      const status = el.querySelector('#setPwStatus');
      if (pw.length < 6) { status.textContent = 'Use at least 6 characters.'; return; }
      e.target.disabled = true;
      const { error } = await cloud.setPassword(pw);
      e.target.disabled = false;
      if (error) status.textContent = 'Could not set the password: ' + error.message;
      else {
        el.querySelector('#setPwInput').value = '';
        status.textContent = 'Password set. You can now sign in with it on any device.';
      }
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
