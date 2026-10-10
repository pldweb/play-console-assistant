/**
 * SYNTHETIC Play Console page fixtures for adapter tests.
 *
 * Built from the labels in docs/SELECTOR_MAP.md. appList, createApp and
 * storeListing follow the structure read from the live console on
 * 2026-10-10 (reduced, no generated classes); the others are still
 * UNVERIFIED. None of these is a raw capture.
 */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const FIXTURES = {
  appList: (names) => `<nav><div role="listitem"><a href="#">Home</a></div><div role="listitem"><a href="#">Policy status</a></div></nav>
    <main><div role="heading" aria-level="1">Rinkweb Studio</div><div role="heading" aria-level="2">${names.length} apps</div>
    <a role="link" href="#create">Create app</a>
    <div role="grid"><div role="row"><div role="columnheader">App</div><div role="columnheader">App status</div></div>
    ${names.map((n) => `<div role="row"><div role="gridcell"><img aria-hidden="true" src="data:,"><div><div text>${esc(n)}</div></div><div><div subtext>com.x</div></div></div><div role="gridcell">Draft</div></div>`).join('')}</div></main>`,

  createApp: ({ duplicateNameField = false, packageStatus = '' } = {}) => `<main><div role="heading" aria-level="1">Create app</div>
    <div><label>App name</label><input type="text" aria-label="App name"><span>0 / 30</span></div>
    ${duplicateNameField ? '<div><input type="text" aria-label="App name"></div>' : ''}
    <div><label>Package name</label><input type="text" aria-label="App package name"><button type="button">Check availability</button>
      <div aria-live="polite">${packageStatus ? `<i aria-hidden="true">check_circle</i> ${esc(packageStatus)}` : ''}</div></div>
    <div role="button" tabindex="0" aria-haspopup="listbox" aria-controls="pop" aria-label="Default language: English (United States) – en-US"><span>English (United States) – en-US</span> <i role="img" aria-hidden="true">arrow_drop_down</i></div><div role="none" id="pop"></div>
    <div role="radiogroup" aria-label="Choose the category of your application"><input type="radio" id="k1" name="k"><label for="k1">App</label><input type="radio" id="k2" name="k"><label for="k2">Game</label></div>
    <div role="radiogroup" aria-label="Choose if your application is free or paid"><input type="radio" id="p1" name="p"><label for="p1">Free</label><input type="radio" id="p2" name="p"><label for="p2">Paid</label></div>
    <div><input type="checkbox" aria-labelledby="d1"><div id="d1">Confirm app meets the Developer Program PoliciesThe application meets Developer Program Policies.</div></div>
    <div><input type="checkbox" aria-labelledby="d2"><div id="d2">Accept US export lawsI acknowledge that my software application may be subject to United States export laws.</div></div>
    <button type="button" disabled>Create app</button><button type="button">Cancel</button></main>`,

  // addAssets: live markup (no file input, "Add assets" dialog button).
  storeListing: ({ iconCount = 0, video = '', addAssets = false } = {}) => {
    const upload = addAssets ? '<button type="button">Add assets</button>' : '<input type="file" class="cdk-visually-hidden" aria-hidden="true">';
    return `<main><div role="heading" aria-level="1">Default store listing</div>
    <div role="heading" aria-level="2">Common text assets</div>
    <div role="group"><label><span id="tl">App name</span> <span aria-label="Required field">*</span></label><input id="t" type="text" aria-labelledby="tl"><span>0 / 30</span></div>
    <div role="group"><label><span id="sl">Short description</span> *</label><input id="s" type="text" aria-labelledby="sl"></div>
    <div role="group"><label><span id="fl">Full description</span> *</label><textarea id="f" aria-labelledby="fl"></textarea></div>
    <div role="heading" aria-level="2">Common visual assets</div>
    <div role="group"><label><div>App icon</div> <span aria-label="Required field">*</span></label><p>Your app icon must be a PNG or JPEG</p>${'<img alt="icon" src="data:,">'.repeat(iconCount)}${upload}</div>
    <div role="group"><label><div>Feature graphic</div> *</label>${upload}</div>
    <div role="group"><label><span id="vl">Video</span></label><input id="v" type="text" aria-labelledby="vl" value="${esc(video)}"></div>
    <button type="button" disabled>Discard</button><button type="button">Save as draft</button><button type="button">Next</button><div role="status"></div></main>`;
  },

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
