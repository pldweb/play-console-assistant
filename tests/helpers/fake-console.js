/**
 * Simulated Google Play Console for workflow tests.
 *
 * SYNTHETIC: page markup follows the labels documented in
 * docs/SELECTOR_MAP.md (all UNVERIFIED). It is NOT captured from the live
 * Play Console; it exists to exercise the engine and adapters end to end:
 * navigation, rendering delays, saving + reload, uploads, dialogs and
 * injected faults.
 */
import { JSDOM } from 'jsdom';
import { createContentHandler } from '../../src/content/message-handler.js';
import { PCAError, ERROR_CODES } from '../../src/services/errors.js';

const ORIGIN = 'https://play.google.com';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MANUAL = ['Content rating', 'Target audience and content', 'Data safety'];
const LANGS = [['English (United States)', 'en-US'], ['English (United Kingdom)', 'en-GB'], ['Indonesian', 'id']];
const CATEGORIES = ['Productivity', 'Tools', 'Education', 'Puzzle'];
const GRAPHIC_SECTIONS = [['appIcon', 'App icon', false], ['featureGraphic', 'Feature graphic', false], ['phoneScreenshots', 'Phone screenshots', true], ['tablet7Screenshots', '7-inch tablet screenshots', true], ['tablet10Screenshots', '10-inch tablet screenshots', true]];

/** jsdom has no DataTransfer and only accepts FileList for input.files. */
export function installFilePolyfills(win) {
  win.DataTransfer = class DataTransfer {
    constructor() { this._files = []; this.items = { add: (f) => { this._files.push(f); } }; }
    get files() { return this._files; }
  };
  Object.defineProperty(win.HTMLInputElement.prototype, 'files', {
    configurable: true,
    get() { return this._pcaFiles || []; },
    set(v) { this._pcaFiles = v; },
  });
}

export function newApp(name, extra = {}) {
  return {
    name,
    packageName: '',
    listing: { title: name, shortDescription: '', fullDescription: '', video: '' },
    graphics: { appIcon: [], featureGraphic: [], phoneScreenshots: [], tablet7Screenshots: [], tablet10Screenshots: [] },
    settings: { category: '', email: '', phone: '', website: '' },
    privacyPolicyUrl: '',
    ads: null,
    access: null,
    manualTodo: [...MANUAL],
    release: { draft: false, bundles: [], name: '', notes: '' },
    inReview: false,
    errors: [],
    ...extra,
  };
}

export class FakeConsole {
  constructor({ developerId = '5550001', userIndex = 0, apps = {}, bundleVersionCode = 1, bundlePackage = 'com.acme.notes' } = {}) {
    this.developerId = developerId;
    this.userIndex = userIndex;
    this.apps = new Map(Object.entries(apps));
    this.nextAppId = 4970000000000000001n;
    this.bundleVersionCode = bundleVersionCode;
    this.bundlePackage = bundlePackage;
    this.tabs = new Map();
    this.faults = {};
    this.clicks = []; // audit of consequential clicks
    this.assets = new Map(); // assetId -> { appId, name, type, bytes }
  }

  // ------------------------------------------------------------- helpers
  base() { return `${ORIGIN}/console/u/${this.userIndex}/developers/${this.developerId}`; }
  appBase(appId) { return `${this.base()}/app/${appId}`; }
  url(path) { return `${this.base()}/${path}`; }

  openTab(tabId, url) {
    this.tabs.set(tabId, { id: tabId, url: null, status: 'complete', dom: null, handler: null, signedOut: false });
    this.load(tabId, url);
    return tabId;
  }

  completeManualSections(appId) { this.apps.get(appId).manualTodo = []; }

  // -------------------------------------------------------------- gateway
  gateway() {
    return {
      getTab: async (tabId) => {
        const t = this.tabs.get(tabId);
        if (!t) return null;
        // Host-permission emulation: URLs outside Play Console are hidden.
        return { id: tabId, status: t.status, url: t.signedOut ? undefined : t.url };
      },
      send: async (tabId, msg, timeoutMs) => {
        const t = this.tabs.get(tabId);
        if (!t || !t.handler || t.status === 'loading' || t.signedOut) {
          throw new PCAError(ERROR_CODES.CONTENT_SCRIPT_UNAVAILABLE, 'Could not establish connection. Receiving end does not exist.');
        }
        const f = this.faults.dropResponse;
        if (f && msg.type === 'PCA_APPLY' && msg.step === f.step && f.times > 0) {
          f.times -= 1;
          t.handler(msg).catch(() => {});
          await new Promise((r) => setTimeout(r, 30));
          throw new PCAError(ERROR_CODES.ACTION_TIMEOUT, `No response within ${timeoutMs} ms.`);
        }
        return t.handler(msg);
      },
      navigate: async (tabId, url) => { this.load(tabId, url); },
      reload: async (tabId) => { this.load(tabId, this.tabs.get(tabId).url); },
    };
  }

  load(tabId, url) {
    const t = this.tabs.get(tabId);
    if (this.faults.sessionExpired) {
      t.signedOut = true;
      t.url = 'https://accounts.google.com/v3/signin';
      t.dom = null;
      t.handler = null;
      return;
    }
    t.url = url;
    const html = this.render(url);
    const delay = this.faults.renderDelayMs || 0;
    const build = (body) => {
      const dom = new JSDOM(`<!doctype html><html><head><title>Google Play Console</title></head><body>${body}</body></html>`, { url });
      installFilePolyfills(dom.window);
      t.dom = dom;
      t.handler = createContentHandler({
        document: dom.window.document,
        getHref: () => dom.window.location.href,
        getAsset: async (assetId, appId) => {
          const a = this.assets.get(assetId);
          if (!a || a.appId !== appId) throw new PCAError(ERROR_CODES.ASSET_MISSING, 'Asset not available for this app.');
          return new dom.window.File([a.bytes], a.name, { type: a.type });
        },
      });
      this.wire(tabId, dom, url);
    };
    if (delay) {
      build('<div role="progressbar" aria-label="Loading"></div>');
      setTimeout(() => { if (t.url === url) build(html); }, delay);
    } else {
      build(html);
    }
  }

  doc(tabId) { return this.tabs.get(tabId).dom.window.document; }

  // --------------------------------------------------------------- render
  route(url) {
    const u = new URL(url);
    const m = u.pathname.match(/^\/console\/u\/\d+\/developers\/[^/]+\/(.*)$/);
    if (!m) return { page: 'unknown' };
    const rest = m[1];
    if (rest === 'app-list') return { page: 'list' };
    if (rest === 'create-new-app') return { page: 'create' };
    const am = rest.match(/^app\/([^/]+)\/(.*)$/);
    if (!am) return { page: 'unknown' };
    const [, appId, sub] = am;
    if (!this.apps.has(appId)) return { page: 'unknown' };
    const map = {
      'app-dashboard': 'dashboard', 'main-store-listing': 'listing', 'store-settings': 'settings',
      'app-content/overview': 'content', 'app-content/privacy-policy': 'privacy', 'app-content/ads-declaration': 'ads',
      'app-content/testing-credentials': 'access', 'tracks/internal-testing': 'track', publishing: 'publishing',
    };
    if (map[sub]) return { page: map[sub], appId };
    if (/^tracks\/internal-testing\/releases\/\d+\/prepare$/.test(sub)) return { page: 'release', appId };
    return { page: 'unknown', appId };
  }

  shell(appId, inner) {
    const app = appId ? this.apps.get(appId) : null;
    const header = app ? `<div aria-label="Selected app"><span>${esc(app.name)}</span> <span>${esc(app.packageName)}</span></div>` : '';
    return `<header><nav aria-label="Main navigation"><a href="#">All apps</a></nav>${header}</header><main>${inner}</main><div role="status" aria-live="polite"></div>`;
  }

  render(url) {
    const r = this.route(url);
    const app = r.appId ? this.apps.get(r.appId) : null;
    switch (r.page) {
      case 'list': {
        const rows = [...this.apps.values()].map((a) => `<div role="row"><div role="rowheader">${esc(a.name)}</div><div role="cell">${esc(a.packageName || '—')}</div></div>`).join('');
        return this.shell(null, `<h1>All apps</h1><button type="button">Create app</button>
          <div role="table" aria-label="Apps"><div role="row"><div role="columnheader">App</div><div role="columnheader">Package</div></div>${rows}</div>`);
      }
      case 'create': {
        const extra = this.faults.unknownCreateQuestion
          ? '<div><input type="checkbox" id="d3"><label for="d3">I agree to the new Play App Signing terms of service</label></div>' : '';
        const opts = LANGS.map(([n, c]) => `<li role="option" aria-selected="${c === 'en-US'}">${n} – ${c}</li>`).join('');
        return this.shell(null, `<h1>Create app</h1>
          <form aria-label="Create app">
            <section aria-labelledby="h-det"><h2 id="h-det">App details</h2>
              <div><label for="f-name">App name</label><input id="f-name" maxlength="30"><span>0/30</span></div>
              <div><span id="lang-l">Default language</span>
                <div role="combobox" tabindex="0" aria-labelledby="lang-l" aria-expanded="false" aria-controls="lang-list">English (United States) – en-US</div>
                <ul role="listbox" id="lang-list" hidden>${opts}</ul></div>
              <fieldset><legend>App or game</legend><label><input type="radio" name="kind">App</label><label><input type="radio" name="kind">Game</label></fieldset>
              <fieldset><legend>Free or paid</legend><label><input type="radio" name="price">Free</label><label><input type="radio" name="price">Paid</label></fieldset>
            </section>
            <section aria-labelledby="h-dec"><h2 id="h-dec">Declarations</h2>
              <div><input type="checkbox" id="d1"><label for="d1">Developer Program Policies: Confirm that this app meets the Developer Program Policies</label></div>
              <div><input type="checkbox" id="d2"><label for="d2">US export laws: Accept that your app is subject to US export laws</label></div>
              ${extra}
            </section>
            <div id="create-errors"></div>
            <button type="button">Create app</button>
          </form>`);
      }
      case 'dashboard': {
        const tasks = this.dashboardTasks(app).map(([name, done]) => `<li aria-label="${done ? 'Completed' : 'Not completed'}: ${esc(name)}"><a href="#">${esc(name)}</a></li>`).join('');
        return this.shell(r.appId, `<h1>Dashboard</h1><section aria-labelledby="setup"><h2 id="setup">Set up your app</h2><ul>${tasks}</ul></section>`);
      }
      case 'listing': {
        const sections = GRAPHIC_SECTIONS.map(([key, title, multi]) => {
          const imgs = app.graphics[key].map((n) => `<img src="data:," alt="${esc(n)}">`).join('');
          return `<section aria-label="${title}"><h3>${title}</h3><div>${imgs}</div><input type="file" accept="image/png,image/jpeg" ${multi ? 'multiple' : ''} aria-hidden="true"><button type="button">Upload</button></section>`;
        }).join('');
        return this.shell(r.appId, `<h1>Main store listing</h1>
          <section aria-labelledby="det"><h2 id="det">App details</h2>
            <label for="t">App name</label><input id="t" value="${esc(app.listing.title)}"><span>${[...app.listing.title].length}/30</span>
            <label for="sd">Short description</label><textarea id="sd">${esc(app.listing.shortDescription)}</textarea>
            <label for="fd">Full description</label><textarea id="fd">${esc(app.listing.fullDescription)}</textarea>
          </section>
          <section aria-labelledby="gr"><h2 id="gr">Graphics</h2>${sections}
            <label for="v">Video</label><input id="v" type="url" value="${esc(app.listing.video)}">
          </section>
          <button type="button">Save</button>`);
      }
      case 'settings': {
        const opts = ['', ...CATEGORIES].map((c) => `<option value="${esc(c)}" ${app.settings.category === c ? 'selected' : ''}>${c || 'Select a category'}</option>`).join('');
        return this.shell(r.appId, `<h1>Store settings</h1>
          <section aria-labelledby="cat"><h2 id="cat">App category</h2><label for="c">Category</label><select id="c">${opts}</select></section>
          <section aria-labelledby="con"><h2 id="con">Store listing contact details</h2>
            <label for="em">Email address</label><input id="em" type="email" value="${esc(app.settings.email)}">
            <label for="ph">Phone number</label><input id="ph" type="tel" value="${esc(app.settings.phone)}">
            <label for="ws">Website</label><input id="ws" type="url" value="${esc(app.settings.website)}">
          </section><button type="button">Save</button>`);
      }
      case 'privacy':
        return this.shell(r.appId, `<h1>Privacy policy</h1><label for="pp">Privacy policy URL</label><input id="pp" type="url" value="${esc(app.privacyPolicyUrl)}"><button type="button">Save</button>`);
      case 'ads':
        return this.shell(r.appId, `<h1>Ads</h1><div role="radiogroup" aria-label="Does your app contain ads?">
          <label><input type="radio" name="ads" ${app.ads === 'yes' ? 'checked' : ''}>Yes, my app contains ads</label>
          <label><input type="radio" name="ads" ${app.ads === 'no' ? 'checked' : ''}>No, my app does not contain ads</label></div>
          ${this.faults.unknownAdsQuestion ? '<label><input type="checkbox">My ads are served by a certified ad network</label>' : ''}
          <button type="button">Save</button>`);
      case 'access':
        return this.shell(r.appId, `<h1>App access</h1><div role="radiogroup" aria-label="App access">
          <label><input type="radio" name="acc" ${app.access === 'all' ? 'checked' : ''}>All functionality is available without special access</label>
          <label><input type="radio" name="acc" ${app.access === 'restricted' ? 'checked' : ''}>All or some functionality is restricted</label></div>
          <button type="button">Save</button>`);
      case 'content': {
        const todo = this.contentTodo(app);
        const todoHtml = todo.length ? `<section aria-labelledby="todo"><h2 id="todo">To do</h2><ul>${todo.map((n) => `<li><h3>${esc(n)}</h3><a href="#">Start</a></li>`).join('')}</ul></section>` : '';
        return this.shell(r.appId, `<h1>App content</h1>${todoHtml}<section aria-labelledby="done"><h2 id="done">Actioned</h2><ul></ul></section>`);
      }
      case 'track':
        return this.shell(r.appId, `<h1>Internal testing</h1>${app.release.draft ? '<button type="button">Edit release</button>' : '<button type="button">Create new release</button>'}`);
      case 'release': {
        const rows = app.release.bundles.map((b) => `<li>Version code ${b.versionCode} (1.0) · ${esc(b.packageName)}</li>`).join('');
        return this.shell(r.appId, `<h1>Create internal testing release</h1>
          <section aria-label="App bundles"><h2>App bundles</h2><ul>${rows}</ul><input type="file" accept=".aab" aria-hidden="true"><button type="button">Upload</button></section>
          <section aria-labelledby="rd"><h2 id="rd">Release details</h2>
            <label for="rn">Release name</label><input id="rn" value="${esc(app.release.name)}">
            <label for="notes">Release notes</label><textarea id="notes">${esc(app.release.notes)}</textarea>
          </section><button type="button">Save</button>`);
      }
      case 'publishing': {
        const ready = app.release.bundles.length && this.contentTodo(app).length === 0;
        const errs = app.errors.length ? `<section aria-label="Errors"><h2>Errors</h2><ul>${app.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></section>` : '';
        let action = '<p>No changes are ready to send for review.</p>';
        if (app.inReview) action = '<p>Changes in review</p>';
        else if (ready) action = '<button type="button">Send 5 changes for review</button>';
        return this.shell(r.appId, `<h1>Publishing overview</h1>${errs}<section aria-labelledby="ch"><h2 id="ch">Changes not yet sent for review</h2>${action}</section>
          <p>Personal accounts need a closed test with at least 12 testers for 14 days before applying for production access.</p>`);
      }
      default:
        return '<h1>Something went wrong</h1>';
    }
  }

  contentTodo(app) {
    const t = [...app.manualTodo];
    if (!app.privacyPolicyUrl) t.push('Privacy policy');
    if (!app.ads) t.push('Ads');
    if (!app.access) t.push('App access');
    return t;
  }

  dashboardTasks(app) {
    return [
      ['Set up your store listing', Boolean(app.listing.shortDescription && app.graphics.appIcon.length)],
      ['Complete app content', this.contentTodo(app).length === 0],
    ];
  }

  // --------------------------------------------------------------- wiring
  wire(tabId, dom, url) {
    const doc = dom.window.document;
    const r = this.route(url);
    const app = r.appId ? this.apps.get(r.appId) : null;
    const status = doc.querySelector('[role=status]');
    const later = (fn, ms = 5) => setTimeout(fn, ms);
    const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

    doc.addEventListener('click', (ev) => {
      const t = ev.target;
      const combo = t.closest('[role=combobox]');
      if (combo) {
        const list = doc.getElementById(combo.getAttribute('aria-controls'));
        list.hidden = !list.hidden;
        combo.setAttribute('aria-expanded', String(!list.hidden));
        return;
      }
      const opt = t.closest('[role=option]');
      if (opt) {
        const list = opt.closest('[role=listbox]');
        const c = doc.querySelector(`[aria-controls="${list.id}"]`);
        list.querySelectorAll('[role=option]').forEach((o) => o.setAttribute('aria-selected', String(o === opt)));
        c.textContent = text(opt);
        list.hidden = true;
        c.setAttribute('aria-expanded', 'false');
        return;
      }
      const btn = t.closest('button');
      if (!btn) return;
      const label = text(btn);
      if (r.page === 'list' && label === 'Create app') {
        this.clicks.push('open-create');
        later(() => this.load(tabId, this.url('create-new-app')));
      } else if (r.page === 'create' && label === 'Create app') {
        this.clicks.push('create-app');
        const name = doc.getElementById('f-name').value;
        const boxes = [...doc.querySelectorAll('input[type=checkbox]')];
        if (!name || boxes.some((b) => !b.checked)) {
          doc.getElementById('create-errors').innerHTML = '<div role="alert">Complete all required fields.</div>';
          return;
        }
        const id = String(this.nextAppId++);
        this.apps.set(id, newApp(name));
        if (!this.faults.createWithoutNavigation) later(() => this.load(tabId, `${this.appBase(id)}/app-dashboard`));
      } else if (label === 'Save') {
        this.save(r, app, doc);
        if (!this.faults.saveError) {
          btn.disabled = true;
          status.textContent = 'Changes saved';
        }
      } else if (r.page === 'track' && label === 'Create new release') {
        this.clicks.push('create-release');
        app.release.draft = true;
        later(() => this.load(tabId, `${this.appBase(r.appId)}/tracks/internal-testing/releases/1/prepare`));
      } else if (r.page === 'track' && label === 'Edit release') {
        later(() => this.load(tabId, `${this.appBase(r.appId)}/tracks/internal-testing/releases/1/prepare`));
      } else if (r.page === 'publishing' && /^Send \d+ changes for review$/.test(label)) {
        this.clicks.push('send-for-review');
        const dlg = doc.createElement('div');
        dlg.setAttribute('role', 'dialog');
        dlg.innerHTML = '<h2>Send changes for review?</h2><button type="button">Cancel</button><button type="button">Send changes for review</button>';
        doc.body.appendChild(dlg);
      } else if (r.page === 'publishing' && label === 'Send changes for review') {
        this.clicks.push('confirm-send');
        app.inReview = true;
        later(() => this.load(tabId, url));
      }
    }, true);

    doc.addEventListener('change', (ev) => {
      const input = ev.target;
      if (input.type !== 'file') return;
      const section = input.closest('section');
      const files = [...input.files];
      if (r.page === 'listing') {
        later(() => {
          if (this.faults.uploadError) {
            section.insertAdjacentHTML('beforeend', `<div role="alert">${esc(this.faults.uploadError)}</div>`);
            return;
          }
          for (const f of files) section.querySelector('div').insertAdjacentHTML('beforeend', `<img src="data:," alt="${esc(f.name)}">`);
        });
      } else if (r.page === 'release') {
        later(() => {
          if (this.faults.bundleError) {
            section.insertAdjacentHTML('beforeend', `<div role="alert">${esc(this.faults.bundleError)}</div>`);
            return;
          }
          app.release.bundles.push({ versionCode: this.bundleVersionCode, packageName: this.bundlePackage });
          app.packageName = this.bundlePackage;
          section.querySelector('ul').insertAdjacentHTML('beforeend', `<li>Version code ${this.bundleVersionCode} (1.0) · ${esc(this.bundlePackage)}</li>`);
          this.clicks.push('bundle-uploaded');
        }, this.faults.processingMs || 10);
      }
    });
  }

  save(r, app, doc) {
    if (this.faults.saveError) {
      doc.querySelector('main').insertAdjacentHTML('beforeend', `<div role="alert">${esc(this.faults.saveError)}</div>`);
      return;
    }
    const v = (id) => doc.getElementById(id).value;
    if (r.page === 'listing') {
      app.listing = { title: v('t'), shortDescription: v('sd'), fullDescription: v('fd'), video: v('v') };
      for (const [key, title] of GRAPHIC_SECTIONS) {
        const sec = doc.querySelector(`section[aria-label="${title}"]`);
        app.graphics[key] = [...sec.querySelectorAll('img')].map((i) => i.getAttribute('alt'));
      }
    } else if (r.page === 'settings') {
      app.settings = { category: v('c'), email: v('em'), phone: v('ph'), website: v('ws') };
    } else if (r.page === 'privacy') {
      app.privacyPolicyUrl = v('pp');
    } else if (r.page === 'ads') {
      const radios = [...doc.querySelectorAll('input[name=ads]')];
      app.ads = radios[0].checked ? 'yes' : radios[1].checked ? 'no' : null;
    } else if (r.page === 'access') {
      const radios = [...doc.querySelectorAll('input[name=acc]')];
      app.access = radios[0].checked ? 'all' : radios[1].checked ? 'restricted' : null;
    } else if (r.page === 'release') {
      app.release.name = v('rn');
      app.release.notes = v('notes');
    }
  }
}
