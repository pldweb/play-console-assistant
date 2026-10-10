# Troubleshooting

Every stop shows an error code, a message and a **Next:** hint in the dashboard and popup. The app's **Log** in the dashboard lists every step with its outcome.

## Error codes

| Code | Meaning | What to do |
|---|---|---|
| `VALIDATION_FAILED` | Record data is incomplete or invalid | Open **Edit data** → **Check readiness**, fix the listed items, then Start/Resume |
| `NO_CONSOLE_TAB` / `TAB_CLOSED` | No automation tab selected, or it was closed | Open Play Console, then **Refresh** in the dashboard and select the tab |
| `CONTENT_SCRIPT_UNAVAILABLE` | The extension can't reach the tab (page opened before the extension was loaded or updated, or a navigation in progress) | Reload the Play Console tab, then Resume |
| `SESSION_EXPIRED` | Tab is on the Google sign-in page or left Play Console | Sign in yourself (including 2-Step Verification), open any Play Console page in the same tab, then Resume |
| `UNKNOWN_PAGE` | URL or heading not recognised (new interstitial, redesigned page) | Go to the page named in the message, then Resume. If it keeps happening, update `page-detector.js` (see SELECTOR_MAP) |
| `WRONG_PAGE` / `NAVIGATION_TIMEOUT` | The expected page didn't appear in time | Check the tab; navigate manually if needed; Resume. Increase the page load timeout in Settings for slow connections |
| `IDENTITY_MISMATCH` | The tab shows a different developer account or app than this record | Open the right account/app. If the record is linked to the wrong app, use Recovery → Reset to draft and link the right one |
| `POSSIBLE_DUPLICATE_APP` | An app with the same name exists, or a previous "Create app" could not be confirmed | Open the existing app in the tab → **Link app open in tab**; or, only if it is truly a different app, **Create a new app anyway** |
| `APPROVAL_REQUIRED` | Plan approval is on and the planned changes need your OK | Review the table and **Approve these changes and continue** |
| `ELEMENT_NOT_FOUND` / `AMBIGUOUS_ELEMENT` | A field/button wasn't found, or several matched | Complete the step manually, then Resume (the step is verified from the page). Report the label so SELECTOR_MAP can be updated |
| `UNKNOWN_QUESTION` | Play Console shows a question the extension doesn't know | Answer it yourself, save, Resume |
| `DECLARATION_UNANSWERED` | An answer in the record is still "Not answered" | Answer it in the form (only if true for this app) |
| `PAGE_VALIDATION_ERROR` | Play Console rejected a value on save | Fix the record or the page, then Resume |
| `EXISTING_CONTENT` | Graphics already uploaded, other bundles in the release, or a draft release the extension didn't create | Remove or handle it in Play Console, then Resume. The extension never overwrites |
| `UPLOAD_FAILED` | Play Console showed an error for an upload | Fix the file (see message), re-save assets, Resume |
| `UPLOAD_NOT_CONFIRMED` / `PROCESSING_TIMEOUT` | Upload result not visible in time | Check the page; Resume re-inspects before uploading again (an already listed bundle is not uploaded twice) |
| `VERSION_CODE_CONFLICT` | Version code already used | Build a bundle with a higher versionCode, re-select it, Resume |
| `PACKAGE_MISMATCH` | Bundle package name differs from the record or the Play Console app | Select the correct `.aab` |
| `MANUAL_SECTION_INCOMPLETE` | App content to-do items remain | Complete them in Play Console, Resume |
| `READINESS_ISSUES` | Errors on the publishing overview, open dashboard tasks, or no send action | Resolve them in Play Console, Resume |
| `SUBMISSION_NOT_CONFIRMED` | Confirmation missing, mistyped, expired (5 min), or for another tab/app | Type the exact app name again in the dashboard |
| `INTERRUPTED` | Browser or extension restarted during automation | Check the tab, Resume |
| `LOCKED` | Another app is running, or this app runs in another tab | Pause/stop the other run first |
| `MESSAGE_REJECTED` | A message failed sender or payload checks | Reload the dashboard; if persistent, report it |

## Common situations

**"Not a Play Console tab" in the popup on a Play Console page.**
The extension can read only `https://play.google.com/console/*` URLs. Make sure the URL starts with that. If the tab was opened before the extension was loaded, reload it.

**Folder picker does nothing or errors.**
The form falls back to the browser's folder upload dialog automatically. You can also use **Select files…** and pick the files directly.

**Files changed after saving assets.**
The extension uses the copies saved in its storage. Select the folder again and save to update them; you are asked before anything is replaced.

**Progress shows a stage as done, but Play Console disagrees.**
Use **Recovery → Reset to last checkpoint** to re-check the current stage, or **Reset to draft** to re-inspect everything. Both keep the Play Console link and the record of clicks already made, so the app is not created again.

**Storage.**
Delete apps you no longer need in the dashboard; this removes their stored files. Export a backup first if you want to keep the data.
