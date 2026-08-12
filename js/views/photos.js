// Photos tab: private before/after photos, compressed client-side.
// Stored locally for instant display and mirrored to the private
// Supabase bucket when signed in.
import * as store from '../store.js';
import { G, fmtDate, todayStr, signed, cls, toast, showErr, hideErr } from '../util.js';

function compress(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error('That does not look like an image'));
      img.onload = () => {
        const MAX = 800;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.7));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function addPhoto(which, file, ctx) {
  try {
    const dataUrl = await compress(file);
    const s = store.entries();
    const latest = s[s.length - 1] || null;
    await store.savePhoto(which, { img: dataUrl, date: todayStr(), w: latest ? latest.w : null });
    hideErr();
  } catch (err) {
    showErr(err.message || 'Could not save that photo.');
  }
  ctx.rerender();
}

export function render(ctx) {
  ['before', 'after'].forEach(which => {
    const box = G('box-' + which);
    const p = store.photo(which);
    if (p) {
      box.innerHTML = '<div class="photohead">' + which + '<button class="xbtn" data-rm="' + which + '">✕</button></div>' +
        '<img src="' + p.img + '" alt="' + which + ' photo">' +
        '<div class="photometa">' + fmtDate(p.date) + (p.w != null ? ' · ' + Number(p.w).toFixed(1) + ' kg' : '') + '</div>';
      box.querySelector('[data-rm]').addEventListener('click', () => {
        store.removePhoto(which).catch(() => toast('Removed here; cloud copy may remain'));
        ctx.rerender();
      });
    } else {
      box.innerHTML = '<div class="photohead">' + which + '</div>' +
        '<button class="photoadd" data-add="' + which + '">+ Add ' + which + ' photo</button>';
      box.querySelector('[data-add]').addEventListener('click', () => G('file-' + which).click());
    }
  });
  const b = store.photo('before'), a = store.photo('after');
  const cb = G('compareBox');
  if (b && a) {
    cb.style.display = 'block';
    if (b.w != null && a.w != null) {
      const d = a.w - b.w;
      cb.innerHTML = '<span class="' + cls(d) + '">' + signed(d) + ' between photos</span>';
    } else cb.innerHTML = '<span class="neutral" style="font-weight:400">Side-by-side progress. Nice work.</span>';
  } else cb.style.display = 'none';
}

export function init(ctx) {
  G('file-before').addEventListener('change', e => {
    if (e.target.files[0]) addPhoto('before', e.target.files[0], ctx);
    e.target.value = '';
  });
  G('file-after').addEventListener('change', e => {
    if (e.target.files[0]) addPhoto('after', e.target.files[0], ctx);
    e.target.value = '';
  });
}
