/**
 * SYNTHETIC Play Console page fixtures for adapter tests.
 *
 * Built from the labels in docs/SELECTOR_MAP.md, which are UNVERIFIED.
 * Material-style nesting, character counters, hidden file inputs and
 * aria-* wiring are included on purpose so helpers are exercised against
 * realistic markup — but these are not captures of the live console.
 * Replace them with sanitized captures once selectors are verified.
 */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const FIXTURES = {
  appList: (names) => `<main><h1>All apps</h1><div class="mat-toolbar"><button type="button" class="mdc-button _ngcontent-x1">Create app</button></div>
    <div role="table" aria-label="Apps"><div role="row"><div role="columnheader">App</div></div>
    ${names.map((n) => `<div role="row"><div role="rowheader"><span>${esc(n)}</span></div><div role="cell">com.x</div></div>`).join('')}</div></main>`,

  createApp: ({ duplicateNameField = false } = {}) => `<main><h1>Create app</h1><form>
    <div class="field-wrap"><label for="n">App name</label><div class="mat-input"><input id="n" maxlength="30"><span aria-hidden="true">0/30</span></div></div>
    ${duplicateNameField ? '<div><label for="n2">App name</label><input id="n2"></div>' : ''}
    <div><label for="lang">Default language</label><select id="lang"><option>English (United States) – en-US</option><option>Indonesian – id</option></select></div>
    <fieldset><legend>App or game</legend><label><input type="radio" name="k">App</label><label><input type="radio" name="k">Game</label></fieldset>
    <fieldset><legend>Free or paid</legend><label><input type="radio" name="p">Free</label><label><input type="radio" name="p">Paid</label></fieldset>
    <div><input type="checkbox" id="d1"><label for="d1">Confirm the app meets the Developer Program Policies</label></div>
    <div><input type="checkbox" id="d2"><label for="d2">Accept US export laws</label></div>
    <button type="button">Create app</button></form></main>`,

  storeListing: ({ iconCount = 0, video = '' } = {}) => `<main><h1>Main store listing</h1>
    <section aria-labelledby="d"><h2 id="d">App details</h2>
      <div class="f"><label for="t">App name <span aria-hidden="true">*</span></label><input id="t"><div class="counter">0/30</div></div>
      <div class="f"><label for="s">Short description</label><textarea id="s"></textarea></div>
      <div class="f"><label for="f">Full description</label><textarea id="f"></textarea></div>
    </section>
    <section aria-label="App icon"><h3>App icon</h3>${'<img alt="icon" src="data:,">'.repeat(iconCount)}<input type="file" class="cdk-visually-hidden" aria-hidden="true"></section>
    <section aria-label="Feature graphic"><h3>Feature graphic</h3><input type="file" aria-hidden="true"></section>
    <label for="v">Video</label><input id="v" type="url" value="${esc(video)}">
    <button type="button">Save</button><div role="status"></div></main>`,

  ads: ({ extraQuestion = false } = {}) => `<main><h1>Ads</h1><div role="radiogroup" aria-label="Ads">
    <label><input type="radio" name="a">Yes, my app contains ads</label><label><input type="radio" name="a">No, my app does not contain ads</label></div>
    ${extraQuestion ? '<label><input type="checkbox">My app uses rewarded ads only</label>' : ''}<button type="button">Save</button></main>`,

  appAccess: () => `<main><h1>App access</h1><div role="radiogroup" aria-label="Access">
    <label><input type="radio" name="x">All functionality is available without special access</label>
    <label><input type="radio" name="x">All or some functionality is restricted</label></div><button type="button">Save</button></main>`,

  appContent: (todo) => `<main><h1>App content</h1>
    ${todo.length ? `<section aria-labelledby="t"><h2 id="t">To do</h2><ul>${todo.map((n) => `<li><h3>${esc(n)}</h3><a href="#">Start declaration</a></li>`).join('')}</ul></section>` : ''}
    <section aria-labelledby="a"><h2 id="a">Actioned</h2><ul><li><h3>Privacy policy</h3></li></ul></section></main>`,

  release: ({ bundles = [], error = '' } = {}) => `<main><h1>Create internal testing release</h1>
    <section aria-label="App bundles"><h2>App bundles</h2><ul>${bundles.map((v) => `<li><span>Version code ${v}</span> <span>(1.0)</span></li>`).join('')}</ul>
      <input type="file" accept=".aab" aria-hidden="true">${error ? `<div role="alert">${esc(error)}</div>` : ''}</section>
    <section><h2>Release details</h2><label for="rn">Release name</label><input id="rn"><label for="no">Release notes</label><textarea id="no"></textarea></section>
    <button type="button">Save</button></main>`,

  publishing: ({ errors = [], send = true } = {}) => `<main><h1>Publishing overview</h1>
    ${errors.length ? `<section aria-label="Errors"><h2>Errors</h2><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></section>` : ''}
    <section><h2>Changes not yet sent for review</h2>${send ? '<button type="button">Send 3 changes for review</button>' : '<p>No changes</p>'}</section>
    <p>To publish to production, run a closed test with at least 12 testers for 14 days.</p></main>`,
};
