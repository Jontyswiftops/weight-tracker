// Today tab: header stats, weigh-in form, chips, trend chart, and the
// sign-in / migration banners.
import * as store from '../store.js';
import * as cloud from '../cloud.js';
import { G, todayStr, signed, cls, esc, toast, showErr } from '../util.js';
import { renderChart, weeklyDelta } from '../chart.js';

const NUDGE_KEY = 'wt2:nudgeDismissed';

function streak(s) {
  if (!s.length) return 0;
  const dates = new Set(s.map(e => e.d));
  const pad = n => String(n).padStart(2, '0');
  let cursor = todayStr();
  if (!dates.has(cursor)) {
    const y = new Date(); y.setDate(y.getDate() - 1);
    cursor = y.getFullYear() + '-' + pad(y.getMonth() + 1) + '-' + pad(y.getDate());
    if (!dates.has(cursor)) return 0;
  }
  let c = 0;
  while (dates.has(cursor)) {
    c++;
    const p = cursor.split('-');
    const prev = new Date(p[0], p[1] - 1, p[2] - 1);
    cursor = prev.getFullYear() + '-' + pad(prev.getMonth() + 1) + '-' + pad(prev.getDate());
  }
  return c;
}

function renderBanner(ctx) {
  const el = G('homeBanner');
  const legacy = store.legacySnapshot();
  if (cloud.user() && legacy && !store.migrationDone()) {
    el.innerHTML =
      '<div class="banner"><b>Bring your data into your account</b>' +
      'This device has ' + legacy.data.entries.length + ' check-in' + (legacy.data.entries.length === 1 ? '' : 's') +
      ' from the old tracker. Import them so they sync everywhere.' +
      '<div class="row"><button class="btn small" id="migrateBtn">Import now</button>' +
      '<button class="btn small ghost" id="migrateSkip">Not now</button></div></div>';
    el.querySelector('#migrateBtn').addEventListener('click', async e => {
      e.target.disabled = true;
      try {
        const n = await store.importPayload(legacy);
        toast('Imported ' + n + ' check-in' + (n === 1 ? '' : 's'));
      } catch (err) {
        showErr('Import failed: ' + (err.message || 'please try again.'));
        e.target.disabled = false;
      }
      ctx.rerender();
    });
    el.querySelector('#migrateSkip').addEventListener('click', () => {
      store.dismissMigration();
      ctx.rerender();
    });
    return;
  }
  if (!cloud.user() && !localStorage.getItem(NUDGE_KEY)) {
    el.innerHTML =
      '<div class="banner"><b>Sync and group challenges are here</b>' +
      'Sign in to back up your check-ins and compete with friends. Your weight stays private.' +
      '<div class="row"><button class="btn small" id="nudgeGo">Sign in</button>' +
      '<button class="btn small ghost" id="nudgeSkip">Not now</button></div></div>';
    el.querySelector('#nudgeGo').addEventListener('click', () => ctx.openTab('me'));
    el.querySelector('#nudgeSkip').addEventListener('click', () => {
      localStorage.setItem(NUDGE_KEY, '1');
      ctx.rerender();
    });
    return;
  }
  el.innerHTML = '';
}

export function render(ctx) {
  const s = store.entries();
  const t = store.tracker();
  const latest = s[s.length - 1] || null, first = s[0] || null;
  const start = t.startW != null ? t.startW : (first ? first.w : null);

  // header
  G('bigWeight').innerHTML = (latest ? latest.w.toFixed(1) : '--.-') + '<span> kg</span>';
  const bd = G('bigDelta');
  if (latest && start != null) {
    const d = latest.w - start;
    bd.textContent = signed(d);
    bd.className = 'delta ' + cls(d);
  } else bd.textContent = '';

  const gp = G('goalProgress');
  if (t.goal != null && start != null && latest && start !== t.goal) {
    const pct = Math.max(0, Math.min(100, ((start - latest.w) / (start - t.goal)) * 100));
    const toGo = latest.w - t.goal;
    gp.style.display = 'block';
    G('barFill').style.width = pct + '%';
    G('pctLabel').textContent = pct.toFixed(0) + '% to goal';
    G('toGoLabel').textContent = toGo > 0 ? toGo.toFixed(1) + ' kg to go' : 'Goal reached 🎉';
  } else gp.style.display = 'none';

  // chips
  const st = streak(s);
  G('streakVal').textContent = st + ' day' + (st === 1 ? '' : 's');
  const wd = weeklyDelta(s);
  const wv = G('weekVal');
  wv.textContent = signed(wd);
  wv.className = 'chipval ' + cls(wd);
  G('goalVal').textContent = t.goal != null ? t.goal + ' kg' : 'Set one';

  renderBanner(ctx);

  // chart
  const cardEl = G('chartCard'), emptyEl = G('emptyMsg');
  const drawn = renderChart(G('chart'), s, t.goal);
  cardEl.style.display = drawn ? 'block' : 'none';
  emptyEl.style.display = drawn ? 'none' : 'block';
  G('legendGoal').style.display = t.goal != null ? 'inline' : 'none';
}

export function init(ctx) {
  const wi = G('weightInput'), di = G('dateInput'), sb = G('saveBtn');
  di.value = todayStr();
  di.max = todayStr();
  wi.addEventListener('input', () => { sb.disabled = !parseFloat(wi.value); });
  sb.addEventListener('click', () => {
    const w = parseFloat(wi.value);
    if (!w || w <= 0 || !di.value) return;
    store.saveEntry(di.value, w);
    wi.value = '';
    sb.disabled = true;
    sb.textContent = 'Saved ✓';
    setTimeout(() => { sb.textContent = 'Save check-in'; }, 1600);
    ctx.afterCheckin();
    ctx.rerender();
  });
}
