/**
 * Small DOM rendering helpers for extension pages. User-supplied strings
 * are always inserted as text nodes (never innerHTML).
 */

/** h('div', { class: 'x', onclick: fn }, 'text', child) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Accessible confirmation dialog. Optionally requires the user to type an
 * exact phrase. Resolves true only on explicit confirmation.
 */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, requireText = null, details = null }) {
  return new Promise((resolve) => {
    const input = requireText ? h('input', { type: 'text', autocomplete: 'off', 'aria-describedby': 'cd-req' }) : null;
    const ok = h('button', { type: 'button', class: danger ? 'danger' : 'primary', disabled: Boolean(requireText) }, confirmLabel);
    const cancel = h('button', { type: 'button' }, 'Cancel');
    const dlg = h('dialog', { 'aria-labelledby': 'cd-title' },
      h('h2', { id: 'cd-title' }, title),
      h('p', {}, message),
      details,
      requireText ? [h('p', { id: 'cd-req', class: 'small' }, 'Type ', h('strong', {}, requireText), ' to confirm.'), input] : null,
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:1rem' }, cancel, ok));
    if (input) input.addEventListener('input', () => { ok.disabled = input.value.trim() !== requireText; });
    const finish = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    ok.addEventListener('click', () => finish(input ? input.value.trim() === requireText : true));
    cancel.addEventListener('click', () => finish(false));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    document.body.append(dlg);
    dlg.showModal();
    (input || cancel).focus();
  });
}

/** Announces a message in a polite live region. */
export function announce(region, text, kind = 'info') {
  clear(region, text ? h('div', { class: `notice ${kind === 'error' ? 'danger' : kind}` }, text) : null);
}

/** Triggers a file download for a Blob (extension pages allow this). */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const STATE_BADGE = {
  DRAFT: '', VALIDATING_DATA: 'accent', READY_TO_START: 'accent', SUBMITTED: 'ok', READY_FOR_REVIEW: 'ok',
  SUBMISSION_CONFIRMATION_REQUIRED: 'warn', PAUSED: 'warn', NEEDS_USER_ACTION: 'warn', FAILED: 'danger',
};
