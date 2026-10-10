# Platform audit

Audit date: 2026-10-10.

**No live Play Console access was available.** Everything below comes from public documentation (sources at the end) and is marked as such. No page in this document was inspected live. Every selector, URL and heading the extension uses is therefore **UNVERIFIED** and must be checked with the [manual checklist](TEST_PLAN.md#manual-live-validation-checklist).

## Chrome platform (verified)

| Topic | Finding | Source | How the extension uses it |
|---|---|---|---|
| `storage.local` quota | 10 MB, unlimited with the `unlimitedStorage` permission | Chrome `storage` API reference | Metadata only. Bytes go to IndexedDB; `unlimitedStorage` is requested because bundles can be large. |
| Optional host permissions | Must be requested inside a user gesture | Chrome `permissions` API reference | Not used. A single narrow host permission is simpler and is required for the content script. |
| `showDirectoryPicker` in extension pages | Historically broken in some Chrome versions (Chromium issue 40240444) | Chromium tracker | Used when available, with a fallback to `<input webkitdirectory>` and a multi-file picker. Handles are not persisted. |
| Load extension via DevTools Protocol | `Extensions.loadUnpacked` with `--enable-unsafe-extension-debugging` | Verified by running it | `npm run smoke` loads the extension in Chrome 154. **Verified.** |
| Module service worker, CSP, IndexedDB, DecompressionStream | Work as expected | Verified by `npm run smoke` | — |

## Google Play Console: documented facts

| Area | Documented requirement | Source |
|---|---|---|
| Create app | Home → Create app. Fields: app name (≤ 30 chars), default language, app or game, free or paid. Declarations: Developer Program Policies and US export laws. | Help: *Create and set up your app* |
| Package name | Not entered on the Create app form; fixed by the first uploaded bundle and cannot be changed afterwards. | General Play documentation knowledge. **Not stated on the pages fetched for this audit; confirm live.** The design relies on it: identity before the first upload is the Play Console app ID. |
| Store listing text | App name ≤ 30, short description ≤ 80, full description ≤ 4000 characters | Help: *Create and set up your app* |
| Contact details | Email required; phone optional; website recommended (Store settings → Contact details) | Same |
| App icon | 512 × 512, 32-bit PNG with alpha, ≤ 1024 KB | Help: *Add preview assets* |
| Feature graphic | 1024 × 500, JPEG or 24-bit PNG (no alpha). Byte limit **not stated** on the audited page. | Same |
| Screenshots | JPEG or 24-bit PNG (no alpha); each side 320–3840 px; long side ≤ 2× short side; up to 8 per device type; at least 2 in total to publish. Byte limit not stated. | Same |
| Promo video | Single public or unlisted YouTube URL; no playlists or timecodes; ads off; not age-restricted; embeddable | Same |
| Testing gate | Personal accounts created after 13 Nov 2023: closed test with ≥ 12 opted-in testers for 14 consecutive days before production access | Help: *App testing requirements for new personal developer accounts* |
| Publishing | Errors must be resolved before publishing; draft apps are published through a release | Help: *Publishing status* |

## Page types the extension expects (all UNVERIFIED)

| Page type | URL path after `/console/u/{n}/developers/{devId}/` | Expected main heading |
|---|---|---|
| APP_LIST | `app-list` ✔ live | `N apps` (level 2) ✔ live; level 1 is the developer name |
| CREATE_APP | `create-new-app` ✔ live | `Create app` ✔ live |
| APP_DASHBOARD | `app/{appId}/app-dashboard` ✔ live | `Dashboard` ✔ live |
| STORE_LISTING | `app/{appId}/store-listings/default/edit` ✔ live | `Default store listing` ✔ live |
| STORE_SETTINGS | `app/{appId}/store-settings` | `Store settings` |
| APP_CONTENT_OVERVIEW | `app/{appId}/app-content(/overview)` | `App content` |
| APP_CONTENT_PRIVACY_POLICY | `app/{appId}/app-content/privacy-policy` | `Privacy policy` |
| APP_CONTENT_ADS | `app/{appId}/app-content/ads-declaration` | `Ads` |
| APP_CONTENT_APP_ACCESS | `app/{appId}/app-content/testing-credentials` | `App access` |
| TRACK | `app/{appId}/tracks/internal-testing` (also `tracks/open-testing`, `tracks/production`; closed testing is `app/{appId}/closed-testing`) — paths seen live as nav links | `Internal testing` etc. |
| RELEASE_EDIT | `app/{appId}/tracks/{track}/releases/{id}/(prepare\|create\|edit)` | `Create/Edit … release` |
| PUBLISHING_OVERVIEW | `app/{appId}/publishing` | `Publishing overview` |

✔ live = checked on the real console on 2026-10-10; everything else is still unverified.

A page counts as recognised only when both the URL type and the heading match. Anything else is `UNKNOWN`, and automation stops (`UNKNOWN_PAGE` / `WRONG_PAGE`).

## Navigation assumptions (UNVERIFIED)

- The URL templates above can be opened directly while signed in. If one is wrong, the engine times out on the heading check and stops with `WRONG_PAGE` instead of acting on the wrong page.
- The release editor has no template. The engine reopens it from the track page via **Edit release** (only for a draft it created) or **Create new release**.
- `u/{n}` is the Google account index. It is taken from the current tab when available, otherwise from Settings.

## Upload limitations

- **Mechanism (UNVERIFIED):** files are attached to Play Console's existing `<input type=file>` via `DataTransfer` plus `input` and `change` events, the same thing a drag-and-drop produces.
  - If Play Console's uploader ignores programmatic file assignment, the upload step fails with `UPLOAD_NOT_CONFIRMED` or a timeout. It is never marked as done.
- **Success criterion:** success is only ever judged from the page.
  - Graphics: the number of previews in the section increases.
  - Bundle: a row with the expected version code appears.
- **Bundle checks:** structural only (ZIP + `BundleConfig.pb` + base manifest; package and version code read from the protobuf manifest). Signing, target API level, size limits and policy checks are left to Play Console.
- **Graphic sections:** a section that already shows images blocks the step, because the extension never deletes or overwrites graphics.

## Account-dependent requirements

- New personal accounts: the closed testing requirement above. Production and pre-registration stay disabled until it is met.
- Paid apps need a payments profile; the extension shows a warning.
- Organisation accounts, managed publishing and app-signing state can change which pages and buttons appear. Not modelled; unverified.

## Steps that need a human

- Sign-in, 2-Step Verification, CAPTCHA, account verification, payments profile.
- Content rating, target audience and content, data safety, government/financial/health and other declarations.
- App access instructions and test credentials ("restricted" access).
- Resolving "unknown question", "existing content" or "possible duplicate app" stops.
- Final review of the summary and the typed confirmation before sending for review.
- Closed testing with real testers for new personal accounts.

## Unsupported or unverified

| Item | Status |
|---|---|
| Every Play Console selector, heading and URL template | UNVERIFIED (simulator only) |
| Programmatic file upload into Play Console | UNVERIFIED |
| Tracks other than internal testing | UNVERIFIED |
| Localised store listings, tags, custom store listings | Not supported |
| Data safety and other questionnaires | Deliberately not automated |
| Managed publishing variants of the publishing overview | UNVERIFIED |
| Package-name visibility check after upload | Best effort; UNVERIFIED text |

## Sources

- Play Console Help — Create and set up your app: https://support.google.com/googleplay/android-developer/answer/9859152
- Play Console Help — Add preview assets: https://support.google.com/googleplay/android-developer/answer/9866151
- Play Console Help — Testing requirements for new personal accounts: https://support.google.com/googleplay/android-developer/answer/14151465
- Play Console Help — Publishing status: https://support.google.com/googleplay/android-developer/answer/9859751
- Chrome extensions — storage API: https://developer.chrome.com/docs/extensions/reference/api/storage
- Chrome extensions — permissions API: https://developer.chrome.com/docs/extensions/reference/api/permissions
- Chromium issue 40240444 (showDirectoryPicker in extensions): https://issues.chromium.org/issues/40240444
- Google Play Developer API: https://developers.google.com/android-publisher
