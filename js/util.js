// Shared date/format/dom helpers.

export const pad = n => String(n).padStart(2, '0');

export function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function fmtDate(iso) {
  const p = iso.split('-');
  return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

export function daysBetween(a, b) {
  const pa = a.split('-'), pb = b.split('-');
  return Math.round((new Date(pb[0], pb[1] - 1, pb[2]) - new Date(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

export function signed(v, suf) {
  if (v == null) return '--';
  return (v > 0 ? '+' : '') + v.toFixed(1) + (suf == null ? ' kg' : suf);
}

// Losing weight reads as good (green), gaining as coral.
export function cls(v) {
  return v == null ? 'neutral' : (v < 0 ? 'good' : (v > 0 ? 'bad' : 'neutral'));
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

export const G = id => document.getElementById(id);

export function showErr(m) { const b = G('errBox'); b.textContent = m; b.style.display = 'block'; }
export function hideErr() { G('errBox').style.display = 'none'; }

let toastTimer = null;
export function toast(msg) {
  const t = G('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
