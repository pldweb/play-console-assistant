/*
 * Read-only Play Console page inspector for live selector validation.
 *
 * Paste into the DevTools console on a Play Console page (or run it through
 * Claude in Chrome's javascript_tool). It changes nothing on the page. It
 * returns JSON with the headings, form fields (and where each accessible
 * name comes from: LB = aria-labelledby, AL = aria-label, FOR = <label for>,
 * WRAP = wrapping <label>), buttons/links and labelled sections. Numeric
 * IDs and query strings are stripped so the output is safe to share.
 */
(() => {
  const t = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => el.getClientRects().length > 0;
  const scrub = (s) => String(s || '').split('?')[0].replace(/\d{10,}/g, '{id}');
  const name = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) return `LB:${t(lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(' ')).slice(0, 120)}`;
    if (el.getAttribute('aria-label')) return `AL:${t(el.getAttribute('aria-label')).slice(0, 120)}`;
    if (el.id) {
      const l = [...document.querySelectorAll('label[for]')].find((x) => x.getAttribute('for') === el.id);
      if (l) return `FOR:${t(l.textContent)}`;
    }
    const w = el.closest('label');
    if (w) return `WRAP:${t(w.textContent).slice(0, 120)}`;
    return `NONE: placeholder=${el.placeholder || ''}`;
  };
  const result = {
    path: scrub(location.pathname),
    title: t(document.title),
    headings: [...document.querySelectorAll('h1,h2,h3,[role=heading]')].filter(vis)
      .map((h) => `${h.getAttribute('aria-level') || h.tagName}: ${t(h.textContent).slice(0, 80)}`),
    fields: [...document.querySelectorAll('input,textarea,select,[role=combobox],[role=radio],[role=checkbox],[role=textbox],[contenteditable=true],[aria-haspopup=listbox]')]
      .filter((e) => vis(e) || e.type === 'file')
      .map((e) => `${e.tagName}/${e.type || ''}/role=${e.getAttribute('role') || ''} :: ${name(e)}`),
    buttons: [...document.querySelectorAll('button,[role=button],a[role=link]')].filter(vis)
      .map((b) => `${b.tagName}: ${t(b.textContent).slice(0, 50) || `AL:${b.getAttribute('aria-label')}`}${b.disabled || b.getAttribute('aria-disabled') === 'true' ? ' [disabled]' : ''}`)
      .filter((x) => !/arrow_right/.test(x)),
    sections: [...document.querySelectorAll('section,fieldset,[role=region],[role=group],[role=radiogroup]')].filter(vis)
      .map((s) => {
        const own = [...s.querySelectorAll('label,legend')].find((l) => l.closest('section,fieldset,[role=region],[role=group],[role=radiogroup]') === s);
        return `${s.tagName}/${s.getAttribute('role') || ''}: ${t(s.getAttribute('aria-label') || (own && own.textContent)).slice(0, 60)}`;
      }),
  };
  return JSON.stringify(result, null, 1);
})();
