// Shared helpers for every view.

export const view = document.getElementById('view');

export const session = { user: null, mfl: null };

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    session.user = null;
    go(`#/login?next=${encodeURIComponent(location.hash)}`);
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Teardown hooks (timers, event streams) that run when the user navigates away.
const leaveHooks = [];
export function onLeave(fn) { leaveHooks.push(fn); }
export function runLeaveHooks() { while (leaveHooks.length) leaveHooks.pop()(); }

export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
export function toast(msg, bad = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = bad ? 'bad' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// Wraps an async click/submit handler: shows errors as toasts, disables the button meanwhile.
export function action(fn) {
  return async (e) => {
    e?.preventDefault?.();
    const btn = e?.submitter || (e?.currentTarget instanceof HTMLButtonElement ? e.currentTarget : null);
    if (btn) btn.disabled = true;
    try { await fn(e); } catch (ex) { toast(ex.message, true); } finally { if (btn) btn.disabled = false; }
  };
}

export const fmt = (n) => (Math.round((n || 0) * 100) / 100).toFixed(2);
export const slotPos = (slot) => slot.replace(/\d+$/, '');
export const $ = (sel, root = view) => root.querySelector(sel);
export const $$ = (sel, root = view) => [...root.querySelectorAll(sel)];

export function mflTag(p) {
  return p.mfl_short ? `<span class="mfl-tag">${esc(p.mfl_short)}</span>` : '<span class="mfl-tag muted">FA</span>';
}

export function playerCell(p) {
  return `<span class="pos">${esc(p.position)}</span> ${esc(p.name)} ${mflTag(p)}`;
}

const STAT_SHORT = {
  pass_yds: 'PaYd', pass_td: 'PaTD', pass_int: 'INT', rush_yds: 'RuYd', rush_td: 'RuTD',
  rec: 'Rec', rec_yds: 'ReYd', rec_td: 'ReTD', fumbles_lost: 'FL', two_pt: '2PT',
  bad_snaps: 'BadSnap', sacks_allowed: 'SkAlw',
};
export function statLine(s) {
  if (!s) return '';
  return Object.keys(STAT_SHORT).filter((f) => s[f]).map((f) => `${s[f]} ${STAT_SHORT[f]}`).join(', ');
}

export function weekPicker(current, total) {
  const opts = [];
  for (let w = 1; w <= total; w++) {
    const tag = session.mfl.finalWeeks.includes(w) ? ' ✓' : session.mfl.lockedWeeks.includes(w) ? ' 🔒' : '';
    opts.push(`<option value="${w}" ${w === current ? 'selected' : ''}>Week ${w}${tag}</option>`);
  }
  return `<div class="week-picker">
    <button class="btn ghost small" data-week="${current - 1}" ${current <= 1 ? 'disabled' : ''} aria-label="Previous week">‹</button>
    <select data-week-select aria-label="Week">${opts.join('')}</select>
    <button class="btn ghost small" data-week="${current + 1}" ${current >= total ? 'disabled' : ''} aria-label="Next week">›</button>
  </div>`;
}

export function bindWeekPicker(base) {
  const to = (w) => go(`${base}?week=${w}`);
  $$('[data-week]').forEach((b) => b.addEventListener('click', () => to(b.dataset.week)));
  $('[data-week-select]')?.addEventListener('change', (e) => to(e.target.value));
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

// Simple modal built on <dialog>. Resolves with the form's data, or null if cancelled.
export function modal(title, bodyHtml, submitLabel = 'Confirm') {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${bodyHtml}
      <div class="row-end"><button type="button" class="btn ghost" data-cancel>Cancel</button>
      <button class="btn" value="ok">${esc(submitLabel)}</button></div></form>`;
    document.body.append(d);
    const form = d.querySelector('form');
    d.querySelector('[data-cancel]').addEventListener('click', () => d.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      resolve(Object.fromEntries(new FormData(form)));
      d.close();
    });
    d.addEventListener('close', () => { resolve(null); d.remove(); });
    d.showModal();
  });
}
