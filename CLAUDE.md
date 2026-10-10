# Play Console Assistant: working notes for Claude Code

Read this before you change anything. It holds the context, safety rules and current status that are not obvious from the code. User-facing setup is in [README.md](README.md). Selectors are in [docs/SELECTOR_MAP.md](docs/SELECTOR_MAP.md), the platform audit is in [docs/PLATFORM_AUDIT.md](docs/PLATFORM_AUDIT.md), and the live validation checklist is in [docs/TEST_PLAN.md](docs/TEST_PLAN.md#manual-live-validation-checklist).

## Working with the owner

- Explain things to the owner in **Bahasa Indonesia**. Code, comments, commits and docs stay in English.
- Repo: https://github.com/pldweb/play-console-assistant (public). Do not commit account IDs, app IDs, emails or other personal data. Use placeholders like `{dev}` / `{app}`.

## What it is

A Chrome MV3 extension with no build step and no runtime dependencies. It fills prepared app data into Google Play Console one verified step at a time, and it stops whenever anything is unclear.

- `src/background/service-worker.js` runs the workflow engine (`src/automation/`): the state machine, checkpoints, locks and retry policy.
- `src/content/content-script.js` is a classic loader that dynamically imports `main.js` → `message-handler.js`. The handler runs one step operation per message (`PCA_DETECT` / `PCA_INSPECT` / `PCA_APPLY` / `PCA_VERIFY`).
- `src/content/page-detector.js` decides the page type. **Both** the URL route and a heading must match; otherwise the page is UNKNOWN and automation stops.
- `src/content/dom-utils.js` finds elements by **accessible name only**. It never uses generated classes or positions, and it never guesses: 0 matches gives `ELEMENT_NOT_FOUND`, more than 1 gives `AMBIGUOUS_ELEMENT`.
- `src/adapters/*-adapter.js` hold one stage each (Create app, Store listing, App content, Release, Review readiness, Submission). Each step has `inspect` (read only), `apply` and `verify`.
- `src/data/` holds the record schema and repositories (`chrome.storage` + IndexedDB for files). `src/dashboard/`, `src/form/` and `src/popup/` are the UI.

## Commands

```bash
npm install          # only jsdom, for tests
npm test             # node --test, unit + integration (jsdom + simulated Play Console)
node scripts/smoke.mjs [--headed]   # real Chrome with a throw-away profile; never touches play.google.com
```

Tests run against `tests/helpers/fake-console.js` (a simulated Play Console) and `tests/fixtures/pages.js`. When you change a selector, update the adapter, the simulator/fixtures **and** `docs/SELECTOR_MAP.md` together.

## Safety rules (non-negotiable)

- The **owner** personally ticks the Developer Program Policies and US export laws declarations, presses the **final "Create app"**, handles login and 2-Step Verification, and decides on **any submission for review**. When running live, stop and ask before each of these. Never submit without the owner.
- Keep the setting "Ask me to approve each step's planned changes" **on** (the default) until every stage is live-verified.
- The developer account has **real published or draft apps**. Treat them as read-only: navigating and reading are fine, but never click Save, Create or Delete on them. Do live tests only on the dummy app **"PCA Test 01"** (`com.pldweb.pcatest01`).
- Never add fallback guessing to selectors. An unknown checkbox or radio group must stop with `UNKNOWN_QUESTION`.

## Live validation status (as of 2026-10-10)

Labels were checked with Claude in Chrome (read only). The details are in the "Live" column of `docs/SELECTOR_MAP.md`.

| Area | Status |
|---|---|
| CREATE_APP stage (precheck → fill-form → submit-create) | **Ran live end to end on 2026-10-10** with the adapter code injected into the tab: created "PCA Test 01"; every inspect/apply/verify passed, including the language dropdown and "Check availability" |
| Default store listing (text fields) | Labels read live on the new app; save + reload **not run yet** |
| Saving the store listing, everything after | **Not run live yet** |
| Store settings, App content, Release, Publishing overview | **Unverified** (only the nav-link paths were seen) |

Findings that changed the code:
- App list: the level-1 heading is the **developer account name**; detection uses the level-2 heading `N apps`. "Create app" is a **link** (`a[role=link]`). Apps are in a `role=grid`, and the first `gridcell` holds the name with the package name below it.
- Create app: there is a required **"App package name"** field and a **"Check availability"** button, whose result appears in an `aria-live=polite` region ("Package name available"). The language control is a `div[role=button][aria-haspopup=listbox]` named "Default language: …". Its `[role=option]` items render in an **overlay**, not inside the `aria-controls` popup. Native value setter + input/change events are accepted by the form.
- Store listing: the URL is `app/{app}/store-listings/default/edit` (heading "Default store listing"). `main-store-listing` redirects to the app list. Fields are `role=group` with their own `<label>`. Graphics use an **"Add assets" dialog with no file input**; this is not automated yet and stops with `MANUAL_SECTION_INCOMPLETE`. Saving is done with **"Save as draft"** (next to "Discard" and "Next").
- A **new app has no default listing**: `app/{app}/store-listings` shows a "Create default store listing" button. Opening `app/{app}/store-listings/default/edit` **directly** works anyway (form opens, App name prefilled from the Create app form), which is what the engine does, so no extra step is needed.
- The Create app button is **enabled even while the declarations are unticked**. Never rely on it being disabled; `submit-create` re-verifies every field (including both declarations) first.
- After a full page load, app pages enforce **Trusted Types** (string `eval` is blocked). The extension is unaffected (it loads modules with `import()` from its own files), but a test harness that evals a bundle only works on pages reached by in-app (SPA) navigation from a page that did not enforce it.
- Closed testing lives at `app/{app}/closed-testing`; the other tracks are under `tracks/`.
- `/console/u/0/developers` without an ID is a developer-account chooser page.

## The owner's two workflows

1. **New app, from scratch to AAB upload.** This is the current linear pipeline: CREATE_APP → STORE_LISTING → APP_CONTENT → RELEASE → (REVIEW_READINESS → SUBMISSION, owner only). **Current priority.**
2. **Partial update of an existing app.** For example, changing only the listing text. This is **not designed yet**: the engine always starts at CREATE_APP. An existing app can be linked (`linkCurrentApp`), but it is not possible to pick only some stages or fields. It needs its own mode: link → choose sections → show a diff of current and new values → apply only those sections → verify.

## Next steps

0. Done: "PCA Test 01" (`com.pldweb.pcatest01`, Indonesian – id, App, Free) exists in the account; CREATE_APP is live-verified.
1. The owner loads the unpacked extension and creates the "PCA Test 01" record, then **links** it to the existing app (dashboard → link current app) instead of creating it again. Dummy assets come from `tests/helpers/binary.js` (`makePng`, `makeAab`). They pass the extension's validation, but **Play Console will reject the synthetic .aab**, so a real AAB built with package `com.pldweb.pcatest01` is needed for the Release stage.
2. Run STORE_LISTING through the extension (listing-text save + reload verify). Claude Code's safety classifier blocks Claude from clicking commit buttons (Create, Save) in Play Console unless the owner gives an explicit, specific instruction in chat; the extension itself is not affected.
4. Decide how to handle graphics ("Add assets" dialog): automate it, or keep it manual.
5. Verify App content, Release (internal testing) and Publishing overview live, one page at a time.
6. Then design workflow 2 (partial update mode).
7. When the stages are verified, merge `live-selector-fixes` into `main`.

## Live validation tips (Claude in Chrome)

- If `list_connected_browsers` returns `[]`, the Chrome extension is logged into a different claude.ai account than Claude Code.
- Work in a new tab and read with `javascript_tool`. Results that contain URLs with query strings get blocked, so strip `?…` before returning them. Replace long numeric IDs with placeholders.
- [scripts/live-inspect.js](scripts/live-inspect.js) is a read-only DevTools/`javascript_tool` snippet that lists headings, fields (with how their accessible name is derived), buttons and sections on the current page.
- Play Console headings are `<simple-html role="heading" aria-level="N">`, not `h1`. Material icons leak ligature text (e.g. `arrow_drop_down`, `check_circle`) into `textContent`; they sit under `aria-hidden="true"`.
- Opening and closing a dropdown is harmless. Typing into the Create app form without submitting is harmless (navigating away discards it).
