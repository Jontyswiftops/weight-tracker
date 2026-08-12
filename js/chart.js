// Native-canvas trend chart: daily weigh-ins (light line + dots), 7-day
// rolling average (bold green), dashed amber goal line. No chart library;
// a CDN dependency previously failed inside the iOS Home Screen web app.
import { fmtDate, daysBetween } from './util.js';

export function rollingAvg(s) {
  return s.map(e => {
    const win = s.filter(x => x.d <= e.d && daysBetween(x.d, e.d) <= 6);
    return { d: e.d, label: fmtDate(e.d), w: e.w, avg: win.reduce((a, x) => a + x.w, 0) / win.length };
  });
}

export function weeklyDelta(s) {
  const cd = rollingAvg(s);
  if (cd.length < 8) return null;
  const last = cd[cd.length - 1];
  const older = cd.filter(e => daysBetween(e.d, last.d) >= 7);
  if (!older.length) return null;
  return last.avg - older[older.length - 1].avg;
}

// Draws into #chart. Returns false when there is not enough data yet.
export function renderChart(canvas, sArr, goal) {
  const cd = rollingAvg(sArr);
  if (cd.length < 2) return false;
  const css = getComputedStyle(document.documentElement);
  const green = css.getPropertyValue('--green').trim(), soft = css.getPropertyValue('--soft').trim(),
        gline = css.getPropertyValue('--line').trim(), amber = css.getPropertyValue('--amber').trim();
  const W = Math.max(280, (canvas.parentElement.clientWidth || 320) - 8), H = 240;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  let vals = cd.map(e => e.w);
  if (goal != null) vals = vals.concat([goal]);
  const min = Math.min.apply(null, vals) - 0.8, max = Math.max.apply(null, vals) + 0.8;
  const padL = 36, padR = 10, padT = 10, padB = 24;
  const X = i => padL + (W - padL - padR) * (cd.length === 1 ? 0.5 : i / (cd.length - 1));
  const Y = v => padT + (H - padT - padB) * (1 - (v - min) / (max - min));
  // grid + y labels
  ctx.font = '11px system-ui,sans-serif'; ctx.fillStyle = soft; ctx.textAlign = 'left';
  for (let t = 0; t <= 4; t++) {
    const v = min + (max - min) * t / 4, y = Y(v);
    ctx.strokeStyle = gline; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(v.toFixed(1), 2, y + 4);
  }
  // x labels: first, middle, last
  ctx.textAlign = 'center';
  const idxs = [0, Math.floor((cd.length - 1) / 2), cd.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  idxs.forEach(i => ctx.fillText(cd[i].label, Math.min(Math.max(X(i), padL + 14), W - 24), H - 6));
  // goal line
  if (goal != null && goal > min && goal < max) {
    ctx.strokeStyle = amber; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(padL, Y(goal)); ctx.lineTo(W - padR, Y(goal)); ctx.stroke();
    ctx.setLineDash([]);
  }
  // daily weigh-in line + dots
  ctx.strokeStyle = gline; ctx.lineWidth = 1.5; ctx.beginPath();
  cd.forEach((e, i) => { i === 0 ? ctx.moveTo(X(i), Y(e.w)) : ctx.lineTo(X(i), Y(e.w)); });
  ctx.stroke();
  ctx.fillStyle = soft;
  cd.forEach((e, i) => { ctx.beginPath(); ctx.arc(X(i), Y(e.w), 2.5, 0, Math.PI * 2); ctx.fill(); });
  // 7-day average line
  ctx.strokeStyle = green; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.beginPath();
  cd.forEach((e, i) => { i === 0 ? ctx.moveTo(X(i), Y(e.avg)) : ctx.lineTo(X(i), Y(e.avg)); });
  ctx.stroke();
  return true;
}
