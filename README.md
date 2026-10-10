# Play Console Assistant

A Chrome extension (Manifest V3) that fills **prepared** app data into Google Play Console, one verified step at a time. You give it the app name, listing text, graphics, `.aab`, release notes and your explicit per-app answers. It enters them in your signed-in Play Console tab, checks each result on the page, and stops whenever anything is unclear. It never sends an app for review unless you type that app's name to confirm.

It does **not** build bundles, design graphics, write copy, answer policy questionnaires, or get around sign-in, 2-Step Verification, CAPTCHA or Google's testing requirements.

> **Status: read this first.** Selectors for All apps, the Create app form and the default store listing text were read on the live Play Console on 2026-10-10 (branch `live-selector-fixes`), but no stage has completed a full live run yet, and the other pages are still **UNVERIFIED**. Graphics are added in Play Console through an "Add assets" dialog that the extension does not automate yet. Follow the validation checklist in [docs/TEST_PLAN.md](docs/TEST_PLAN.md#manual-live-validation-checklist) with **one** test app and keep "approve each step" switched on (it is on by default). See [docs/SELECTOR_MAP.md](docs/SELECTOR_MAP.md) and [docs/PLATFORM_AUDIT.md](docs/PLATFORM_AUDIT.md) for what is and isn't known; [CLAUDE.md](CLAUDE.md) has the working notes for continuing development.

## Requirements

- Google Chrome 116 or newer (tested with Chrome 154 on Windows 11).
- Node.js 20+ to run the tests (not needed to use the extension).

## 1. Load the unpacked extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `play-console-assistant` folder (the one that contains `manifest.json`).
4. Pin the extension and click its icon. In the popup, choose **Open dashboard**.

The extension asks only for `storage`, `unlimitedStorage` and access to `https://play.google.com/console/*`.

## 2. Create an application record

1. In the dashboard, click **Add application**.
2. Fill in the form:
   - **App basics:** the app name exactly as it should appear in Play Console, the package name (Play Console now asks for it when the app is created and checks that it is available), the default language code (e.g. `en-US`), app or game, and free or paid.
   - **Creation declarations:** tick these only if they are true for *this* app. Left unticked, they count as "not answered", and automation will not start.
   - **Store listing, contact details, privacy policy URL.**
   - **App content answers:** whether the app contains ads, and app access. "Not answered" is a valid saved state, but it blocks automation.
   - **Release:** track, release notes, and optionally a release name and version.
3. Press **Save**. Use **Check readiness** to see everything still missing before automation can start.

To start a similar app from an existing one, use **Duplicate**. The copy never carries over the package name, files, Play Console link or progress. App-content answers are copied only if you tick the box confirming they apply to the new app.

## 3. Select the asset folder

In the form's **Assets** section:

1. Click **Select folder…** and choose that app's folder. If you prefer to pick files individually, use **Select files…** instead.
2. Files are matched by filename convention. You can change the conventions under Settings in the dashboard. The defaults are:

   | File | Role |
   |---|---|
   | `app-icon.png` or `icon.png` | App icon |
   | `feature-graphic.png` or `.jpg` | Feature graphic |
   | `phone-01.png`, `phone-02.png`, … | Phone screenshots, ordered by the number |
   | `tablet-7-01.png` and `tablet-10-01.png` | Tablet screenshots |
   | any single `*.aab` | Android App Bundle |
   | `release-notes.txt` | Release notes |

3. Review the table. Ambiguous matches, such as two `.aab` files or two `phone-01` files, are **left unassigned** for you to choose. Screenshot order is the **Position** column.
4. Click **Check files**. The extension reads each file's bytes and checks:
   - format;
   - dimensions;
   - alpha channel;
   - icon size limit;
   - screenshot aspect ratio;
   - for the bundle, the ZIP structure, plus the package name and version code from its manifest.
5. Click **Save assets**. The bytes are copied into the extension's IndexedDB. If this would replace any saved file, you are asked to confirm first.

## 4. Validate the application

Press **Check readiness** in the form, or **Validate and start** in the dashboard. Starting is refused, and the app stays a Draft, until every required field, file and answer is present and the bundle's package name matches the record.

## 5. Open the right Play Console page

1. Click **Open Play Console** in the dashboard, or open `https://play.google.com/console/` yourself.
2. Sign in, completing any 2-Step Verification yourself, and go to **All apps** for the right developer account.
3. Back in the dashboard, press **Refresh** under *Automation tab* and select that tab. The line under the selector shows what the extension detects on that page.

If the app already exists in Play Console, open any page of that app in the automation tab and use **Link app open in tab**. The extension will then verify the app instead of creating a new one.

## 6. Start and resume automation

1. Select the app in the dashboard and press **Validate and start**. The stages run in order: Create app → Store listing → App content → Release → Review readiness.
2. With approval on (the default), each writing step stops first and shows a table: field, what was found on the page, the current value, and what will be set. Press **Approve these changes and continue**.
3. **Pause** finishes the current atomic action, then stops. **Resume** continues from the last verified checkpoint. Before acting, it re-detects the page and re-checks that the tab shows the right developer account and the right app.
4. Some stages stop on purpose for you:
   - **App content:** complete Content rating, Target audience, Data safety and any other listed sections yourself in Play Console, then press **Resume**.
   - **App access "restricted":** enter the access instructions yourself.
   - **Unknown question, ambiguous field, or existing content:** resolve it on the page, then resume.

The popup gives the same Start, Pause, Resume and Stop controls for the current tab.

## 7. Errors and re-authentication

Every stop shows an error code, the message, and a **Next:** hint in the dashboard and popup.

- **Signed out (`SESSION_EXPIRED`):** sign in again in the same tab, open any Play Console page, then press **Resume**. The extension never handles credentials.
- **Interrupted:** if the browser or extension restarted mid-run, the app is set to **Paused (INTERRUPTED)**. Check the tab, then resume.
- **Out of sync:** if saved progress no longer matches Play Console, open **Recovery** in the app's detail panel:
  - **Reset to last checkpoint** re-checks the current stage from its first step.
  - **Reset to draft** clears progress but keeps the Play Console link, so the app is not created twice.

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for every error code.

## 8. Review and confirm submission

After the readiness check passes, the app waits in **Awaiting your submit confirmation**. Nothing has been sent at that point.

1. Read the readiness summary (errors, warnings, the testing requirement, the available send action) and check the app in Play Console.
2. Type the app name exactly and press **Send this app for review**, then confirm the final dialog.
   - The confirmation works once, only for this app and the selected tab, and only for 5 minutes.
   - **Cancel** returns the app to *Ready for review* without submitting.
3. The extension marks the app **Submitted** only after Play Console shows the changes as in review.

Personal developer accounts created after 13 Nov 2023 must run a closed test with at least 12 testers for 14 consecutive days before production access. The extension reports this requirement; it cannot shorten or bypass it.

## 9. Export a backup

Dashboard → **Export backup** downloads a JSON file with all application records.
- File bytes (images, bundles) and logs are **not** included.
- **Import…** validates the file and shows what will be added, overwritten or skipped before writing anything. Overwriting requires typing `OVERWRITE`.
- Imported records start as drafts without files, so select their folders again.

## Development

```bash
npm install            # installs jsdom (the only dev dependency)
npm test               # 125 unit + integration tests (node:test)
npm run smoke          # 22 checks in a real Chrome (temp profile, never opens play.google.com)
node scripts/smoke.mjs --headed --screenshots=./shots
node scripts/generate-icons.mjs
```

Documentation:
- [ARCHITECTURE](docs/ARCHITECTURE.md)
- [PLATFORM_AUDIT](docs/PLATFORM_AUDIT.md)
- [SELECTOR_MAP](docs/SELECTOR_MAP.md)
- [TEST_PLAN](docs/TEST_PLAN.md) (includes test results)
- [TROUBLESHOOTING](docs/TROUBLESHOOTING.md)

## Known limitations

- **Unverified UI automation:**
  - All Play Console selectors, URL templates and headings are UNVERIFIED.
  - File uploads assign files to Play Console's file inputs via `DataTransfer`; this is also UNVERIFIED.
- **Tracks:** only the internal testing track page flow is modelled. Other tracks are UNVERIFIED.
- **Store listing scope:** one default-language listing only. No translations, tags or custom store listings.
- **Graphics are never overwritten:**
  - If a graphics section already has images, the extension stops and asks you to remove them manually.
  - Screenshot order is verified only by count, not by image content.
- **Manual questionnaires:** Data safety, content rating, target audience, app access with credentials, and other policy questionnaires are always manual.
- **Bundle checks:** bundle validation is structural only. Play Console's processing result is the authority.
- **Scale:** one application is automated at a time. Batch work is sequential, app by app.
