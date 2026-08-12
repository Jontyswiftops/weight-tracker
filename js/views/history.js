// History tab: reverse-chronological weigh-ins with per-day diffs.
import * as store from '../store.js';
import { G, fmtDate, signed, cls } from '../util.js';

export function render(ctx) {
  const s = store.entries();
  const list = G('historyList');
  if (!s.length) {
    list.innerHTML = '<div class="empty" style="margin-top:0">No check-ins yet.</div>';
    return;
  }
  const rev = [...s].reverse();
  list.innerHTML = rev.map((e, i) => {
    const prev = rev[i + 1];
    const diff = prev ? e.w - prev.w : null;
    return '<div class="hitem">' +
      '<div class="hdate">' + fmtDate(e.d) + ' <small>' + e.d.slice(0, 4) + '</small></div>' +
      '<div class="hweight">' + e.w.toFixed(1) + ' kg</div>' +
      (diff != null ? '<div class="hdiff ' + cls(diff) + '">' + signed(diff, '') + '</div>' : '<div class="hdiff"></div>') +
      '<button class="xbtn" data-del="' + e.d + '" aria-label="Delete">✕</button></div>';
  }).join('');
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    store.deleteEntry(b.dataset.del);
    ctx.rerender();
  }));
}
