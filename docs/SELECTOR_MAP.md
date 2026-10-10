# Selector map

The extension never uses generated class names, positions or framework internals. Elements are located like this:

- **Fields:** by accessible name. The lookup order is `aria-labelledby` → `aria-label` → `<label for>` → wrapping `<label>` → `title` → content → `placeholder`. Required markers (`*`, `(required)`) and character counters (`12/30`) are ignored when matching.
- **Buttons:** exact visible text, or a regular expression where noted.
- **Sections:** a `section`, `fieldset` or `[role=region|group]` whose label, legend or first heading matches.

There is no fallback guessing. Zero matches gives `ELEMENT_NOT_FOUND`, and more than one gives `AMBIGUOUS_ELEMENT`. Either one stops the step.

**Test status legend**
- **Mock:** covered by jsdom tests against the synthetic simulator or fixtures (`tests/helpers/fake-console.js`, `tests/fixtures/pages.js`).
- **Live:** checked on the real Play Console. **No entry is live-verified yet.**

To update an entry after a live check:
1. Run automation with approval on.
2. Read the inspection table in the dashboard (Found / Current / Will set).
3. Fix the label or regex in the adapter, then update this file and the fixtures.

## Page detection

`src/content/page-detector.js`: the URL path and the main `h1` must both match. See [PLATFORM_AUDIT.md](PLATFORM_AUDIT.md#page-types-the-extension-expects-all-unverified). Verification: `detectPage().ready`. Test status: Mock ✔ · Live ✖.

App identity:
- The Play Console app ID comes from the URL `/app/{appId}/`.
- The app name check needs a visible element whose entire text equals the app name (`hasElementWithExactText`, case-sensitive).

## Create app — `create-app-adapter.js`

| Purpose | Locator | Kind | Verification | Status |
|---|---|---|---|---|
| Open the form (app list) | button `/^Create app$/i` | button | navigates to CREATE_APP page | Mock ✔ · Live ✖ |
| Existing apps (duplicate check) | `[role=row]`, `tr`, `[role=listitem]` → first `rowheader`/`th`/`cell`/`td` text | read | exact / prefix name match | Mock ✔ · Live ✖ |
| App name | label `App name` | text | value read back | Mock ✔ · Live ✖ |
| Default language | label `Default language` | native select or ARIA combobox; option text ending in `– {code}` (`languageOptionMatcher`) | selected text matches | Mock ✔ · Live ✖ |
| App or game | radio `App` / `Game` | radio | `checked` | Mock ✔ · Live ✖ |
| Free or paid | radio `Free` / `Paid` | radio | `checked` | Mock ✔ · Live ✖ |
| Policies declaration | checkbox name matching `/Developer Program Policies/i` | checkbox | `checked`; ticked only if the record says `true` | Mock ✔ · Live ✖ |
| Export laws declaration | checkbox matching `/US export laws/i` | checkbox | as above | Mock ✔ · Live ✖ |
| Unknown questions | any other checkbox or radio group on the page | — | stops with `UNKNOWN_QUESTION` | Mock ✔ |
| Submit | button `/^Create app$/i` | button | engine waits for APP_DASHBOARD with the new app ID and the exact app name | Mock ✔ · Live ✖ |

## Store listing — `store-listing-adapter.js`

| Purpose | Locator | Kind | Verification | Status |
|---|---|---|---|---|
| App name | label `App name` | text | read back after reload | Mock ✔ · Live ✖ |
| Short description | label `Short description` | text/textarea | read back after reload | Mock ✔ · Live ✖ |
| Full description | label `Full description` | textarea | read back after reload | Mock ✔ · Live ✖ |
| Video | label `/^Video( URL)?$/i`; untouched when empty | text | read back | Mock ✔ · Live ✖ |
| Graphics sections | section `App icon`, `Feature graphic`, `Phone screenshots`, `7-inch tablet screenshots`, `10-inch tablet screenshots` | section | — | Mock ✔ · Live ✖ |
| Upload control | exactly one enabled `input[type=file]` in the section | file | preview count +1 per file; `role=alert` in the section → `UPLOAD_FAILED` | Mock ✔ · Live ✖ (upload mechanism UNVERIFIED) |
| Existing images | `img`, `[role=img]` in the section | read | any existing image → `EXISTING_CONTENT` | Mock ✔ |
| Category | label `Category` | select | selected text | Mock ✔ · Live ✖ |
| Email / Phone / Website | labels `Email address`, `Phone number`, `Website` | text | read back after reload | Mock ✔ · Live ✖ |
| Save | button `/^Save( changes\| as draft)?$/i` | button | new `role=alert` → `PAGE_VALIDATION_ERROR`; success = button disabled or removed, or a status region contains "saved" | Mock ✔ · Live ✖ |

## App content — `app-content-adapter.js`

| Purpose | Locator | Kind | Verification | Status |
|---|---|---|---|---|
| Privacy policy | label `Privacy policy URL` | text | read back after reload | Mock ✔ · Live ✖ |
| Ads yes / no | radio `/^Yes, my app contains ads$/i` / `/^No, my app does not contain ads$/i` | radio | `checked` after reload; extra controls → `UNKNOWN_QUESTION` | Mock ✔ · Live ✖ |
| App access | radio `/^All functionality (in my app )?is available without (any )?(special )?access( restrictions)?$/i`; restricted `/^All or some functionality (in my app )?is restricted$/i` (manual) | radio | `checked` after reload | Mock ✔ · Live ✖ |
| Outstanding sections | section `/^To do$/i` → `li`/`h3` texts; `/^Actioned$/i` present + no to-do = done; neither → stop | read | none outstanding | Mock ✔ · Live ✖ |

## Release — `release-adapter.js`

| Purpose | Locator | Kind | Verification | Status |
|---|---|---|---|---|
| New draft | button `/^Create new release$/i` | button | navigates to RELEASE_EDIT | Mock ✔ · Live ✖ |
| Own draft | button `/^Edit release$/i` (only when the extension created it; otherwise `EXISTING_CONTENT`) | button | navigates to RELEASE_EDIT | Mock ✔ · Live ✖ |
| Bundle upload | section `/^App bundles$/i` → exactly one `input[type=file]` | file | a row matching `/version code\D{0,5}(\d+)/i` with the expected code; `role=alert` → classified error (`VERSION_CODE_CONFLICT`, `PACKAGE_MISMATCH`, `UPLOAD_FAILED`) | Mock ✔ · Live ✖ |
| Package name check | page text mentions "package name" but not the expected package → mismatch | read | — | Mock (pass path only) · Live ✖ |
| Release name | label `Release name` (only if set) | text | read back after reload | Mock ✔ · Live ✖ |
| Release notes | label `Release notes`; value `<lang>\n…\n</lang>` | textarea | read back after reload | Mock ✔ · Live ✖ |

## Readiness and submission — `review-readiness-adapter.js`

| Purpose | Locator | Kind | Verification | Status |
|---|---|---|---|---|
| Dashboard tasks | section `/^Set up your app$/i` → `li`; done only if its `aria-label` starts with "Completed" | read | — | Mock ✔ · Live ✖ |
| Errors / warnings | sections `/^Errors?$/i`, `/^Warnings?$/i` → `li`; plus `role=alert` | read | none | Mock ✔ · Live ✖ |
| Testing gate text | page text `/(12 testers\|closed test).*(14 days\|production)\|apply for production/i` | read | shown as a note | Mock ✔ · Live ✖ |
| Send action | exactly one button `/^Send (\d+ )?changes? for review$/i` | button | clicked only with a valid confirmation token | Mock ✔ · Live ✖ |
| Dialog confirm | `[role=dialog]`, `[role=alertdialog]`, `dialog[open]` → button `/^Send changes for review$/i` | button | — | Mock ✔ · Live ✖ |
| Submitted status | page text `/\b(changes? )?(are )?in review\b/i` after reload | read | required before `SUBMITTED` | Mock ✔ · Live ✖ |

## Control interaction strategies

These are tested in `tests/integration/dom-utils.test.js`:

| Control | Strategy | Verification |
|---|---|---|
| `input` / `textarea` | Native value setter from the element's prototype, then `input` (InputEvent), `change`, `blur`, `focusout`. This is the same event sequence as user input; no framework internals are used. | `value` read back; mismatch → `VALUE_NOT_APPLIED` |
| `contenteditable` / `role=textbox` | Set `textContent`, then `input` | text read back |
| Native `select` | Option by exact text (or value); ambiguous options → stop | `selectedOptions[0]` |
| ARIA combobox | Click to open, bounded wait for `[role=option]` (scoped by `aria-controls`), click the single match | displayed text contains the option, or `aria-selected` |
| Checkbox / radio (native or ARIA) | `click()` only if the state differs | `checked` / `aria-checked` |
| Buttons | Refuses `disabled` / `aria-disabled` | — |
| File input | `DataTransfer` → `input.files`, then `input` + `change`; a single-file input refuses several files | `files.length` (then the page result) |
