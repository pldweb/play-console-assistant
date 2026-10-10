# Test plan and results

## Levels

| Level | Tooling | What it proves | What it does NOT prove |
|---|---|---|---|
| Unit | `node:test` | Schema, validators, state machine, repositories, file parsing, discovery, import/export, retry, lock, runner, messaging checks, URL parsing | Anything about real pages |
| DOM integration | `node:test` + jsdom | DOM helpers and every adapter against **synthetic** fixtures | That the live Play Console uses these labels |
| Workflow | jsdom simulator of Play Console (`tests/helpers/fake-console.js`) with server-side state, saves, reloads, uploads, dialogs and fault injection | End-to-end engine behaviour: ordering, checkpoints, verification, recovery, identity, confirmation | Live behaviour |
| Browser smoke | Real Chrome 154 via DevTools protocol (`scripts/smoke.mjs`), temporary profile, never opens play.google.com | Manifest, service worker, pages, CSP, storage, messaging, IndexedDB, asset pipeline, content modules in a real browser | Content script on real Play Console, live selectors, uploads into Play Console |
| Manual live | You, on a test app | Selectors, URLs, uploads, submission | — |

## Commands

```bash
npm install
npm test                  # unit + integration
npm run test:unit
npm run test:integration
npm run smoke             # real Chrome; add --headed to watch, --screenshots=DIR for images
```

## Results (2026-10-10, Windows 11, Node 24.16.0, Chrome 154.0.8037.98)

`npm test` gave **125 tests, 125 passed, 0 failed** (about 26 s):

| File | Tests |
|---|---|
| tests/unit/schema.test.js | 16 |
| tests/unit/repositories.test.js | 12 |
| tests/unit/workflow-states.test.js | 10 |
| tests/unit/file-validation.test.js | 14 |
| tests/unit/assets-and-import.test.js | 13 |
| tests/unit/automation.test.js | 7 |
| tests/unit/messaging-and-detection.test.js | 5 |
| tests/integration/dom-utils.test.js | 12 |
| tests/integration/adapters.test.js | 13 |
| tests/integration/workflow.test.js | 23 |

`npm run smoke` gave **22 checks, 22 passed**:

1. Chrome started
2. Extension loads (manifest accepted)
3. Service worker registered
4. Dashboard opens
5. Messaging: ACTIVE_STATUS answered
6. Messaging: unknown type rejected
7. Messaging: invalid payload rejected
8. Messaging: TAB_LIST works
9. Form saves a new application
10. Form blocks an invalid package name with an inline error
11. Data persists after reload
12. `storage.local` holds the record
13. Start with incomplete data is refused and stays DRAFT
14. IndexedDB asset store works and is app-scoped
15. Byte-level image validation runs in the browser
16. Content modules run in Chrome on a synthetic page (detect, apply, verify)
17. Asset discovery maps conventional names and leaves others unassigned
18. Asset byte checks run in the browser
19. Assets saved: metadata in storage, bytes in IndexedDB, bundle identity read
20. Replacing a saved asset asks first; cancel keeps the old one
21. Popup opens
22. No uncaught exceptions or console errors on extension pages

Defects found by these runs and fixed before release:
- **Word matching:** `textContent` glued adjacent elements together ("All appsAcme Notes"), which broke word-boundary matching. Now uses visible text nodes joined with spaces, and exact per-element app-name matching.
- **Dashboard tasks:** "Not completed" tasks were read as completed.
- **Stale page:** a read-only check could trust a page rendered before the user's manual work. Read-only steps now reload first.
- **Uncertain create:** after an uncertain "Create app", the engine navigated away from the possible result page before checking it.
- **Pause race:** pausing right after start was not seen.
- **Submission check:** submission verification waited on a document replaced by a reload. It now verifies after reload.

## Coverage of the specification (§14)

| Requirement | Where |
|---|---|
| Schema, required fields, package name, URL | `schema.test.js` |
| Asset mapping, file type and size validation | `assets-and-import.test.js`, `file-validation.test.js`, smoke 17–20 |
| Workflow transition rules | `workflow-states.test.js`, `automation.test.js` (checkpoint) |
| Checkpoint persistence | `automation.test.js`, `repositories.test.js` |
| Retry policy | `automation.test.js` |
| Application identity matching | `workflow.test.js` (identity, link refusal, batch), `messaging-and-detection.test.js` |
| Import/export validation | `assets-and-import.test.js` |
| Error classification | `automation.test.js` |
| Inputs, textareas, dropdowns, checkboxes, custom controls | `dom-utils.test.js` |
| Missing fields, ambiguous selectors, delayed rendering | `dom-utils.test.js`, `adapters.test.js`, `workflow.test.js` |
| Validation errors | `dom-utils.test.js`, `workflow.test.js` (save rejected) |
| Navigation | `workflow.test.js` (all stages) |
| Duplicate submission prevention | `workflow.test.js` (submission clicked once; create never repeated; token single-use and tab-bound) |
| Successful app creation and listing completion | `workflow.test.js` happy path |
| Missing assets, failed uploads, invalid declarations | `workflow.test.js` |
| Session expiry, unknown page | `workflow.test.js` |
| Browser reload | `workflow.test.js` (`recoverOnStartup`) |
| Timeout after an action that may have succeeded | `workflow.test.js` (dropped response on create; no navigation → stop) |
| Pause and resume | `workflow.test.js` |
| Duplicate package or ambiguous identity | `workflow.test.js` (duplicate name, link refusal), `assets-and-import.test.js` (package conflicts on import) |
| Final submission cancel and confirm | `workflow.test.js` |
| Batch switching | `workflow.test.js` (lock, separate data, logs per app) |
| Load the extension, no manifest errors, dashboard, persistence, messaging | smoke |
| Content-script messaging on the real Play Console | **Not verified.** Needs live access. |
| Play Console page detection on the real site | **Not verified.** |

## Manual live validation checklist

Use **one** throw-away test app in a developer account where creating an app is acceptable. Keep **approval on**. In each step, compare the dashboard's inspection table with what you see on the page.

1. Load the unpacked extension. In `chrome://extensions`, confirm there are no errors, and open the service worker console.
2. Create a record with real test data and a real signed `.aab` (versionCode 1), and select the asset folder. **Check readiness** must show no problems.
3. Open Play Console → All apps. In the dashboard, Refresh, select the tab, and check that the *Detected page* line shows `APP_LIST` with your developer ID.
   - If it shows `UNKNOWN` or "still loading", fix `DEV_ROUTES` / `PAGE_HEADINGS` in `page-detector.js`.
4. **Validate and start.** The precheck stop shows any duplicate names; approve. On the Create app form, check that every field shows *Found: yes* and that no unknown questions are reported. Approve `fill-form`, check the page values, then approve `submit-create`.
5. Confirm that the new app's ID is linked and the stage shows ✓.
6. For each later step:
   - check *Found* and *Current* in the inspection table;
   - after approval, check that Play Console saved the values (the engine reloads and re-reads them);
   - record every label that had to change in this file's history and in `SELECTOR_MAP.md`.
7. **Graphics.** Watch whether attaching files triggers Play Console's upload. If it doesn't, the step stops with `UPLOAD_NOT_CONFIRMED` / `WAIT_TIMEOUT`. Note what the uploader expects.
8. **App content.** Do the questionnaires yourself, then Resume. The sections check should pass.
9. **Release.** Confirm the draft is created on the internal testing track, the bundle row shows version code 1, and the release notes are saved.
10. **Readiness.** Compare the summary with the publishing overview.
11. **Submission.** Only when you really intend to send *this test app* for review, type its name and confirm. Check the "in review" status on the page and the `SUBMITTED` state in the dashboard.
12. **Recovery spot checks:**
    - close the tab mid-step, then resume;
    - sign out mid-run, then sign in and resume;
    - reload the extension mid-run, then resume.
13. Only after all of this, consider switching off per-step approval, and batch a second app.

**Never run an unattended live submission test.**
