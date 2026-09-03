# AGENTS.md

## Direction: stay Advanced-Exclude-agnostic; the fix is the disk-existence guard

This plugin must NOT couple to Advanced Exclude — no `app.advancedExclude`, no "bulk in progress" signal handshake. (In `obsidian-consistent-attachments-and-links`, which owned this handler before, a prototype gating the settings builder's `isPathIgnored` on `app.advancedExclude.isApplyingProjection` was committed then reverted precisely to keep the plugin agnostic.)

The bulk-deletion freeze was caused by the delete handler acting on **index-only removals** — a synthetic `vault.on('delete')` where the file still exists on disk (e.g. when a folder is hidden). The agnostic fix skips the handler when `await this.app.vault.adapter.exists(this.file.path)` is true. It lives in `DeleteHandler.handle()` in `src/rename-delete-handler-component.ts` rather than in the settings builder's `isPathIgnored`, because `isPathIgnored` is synchronous and the existence check is awaited.

## Integration tests

`src/bulk-delete.desktop-performance.integration.test.ts` (vitest project `integration-tests:desktop-performance`, run via `npm run test:integration:desktop:performance`) guards both halves. It seeds `shouldHandleDeletions` and two folders of notes through `scripts/generate-performance-vault.ts` / `scripts/vitest-global-setup-performance.ts`, and installs its own counting, delaying `app.vault.getAvailablePathForAttachments.extended` stub standing in for Custom Attachment Location — so the bottleneck is provable without a 90k-file vault. Ported from `obsidian-consistent-attachments-and-links` at `31678aa^`, when that plugin stopped registering a handler and both of its arms started measuring zero.

- **O(N) reproduction**: a bulk **real** deletion (`trashFile`) of N notes resolves the attachment path exactly once per note — and zero times with the plugin disabled. Real deletions are inherently O(N); the fix does not (and must not) change this.
- **Index-only-removal skip**: firing one `vault.on('delete')` per note **without** removing it from disk must resolve **zero** attachment paths, because the disk-existence guard skips every synthetic removal. A single real deletion enqueued last is the FIFO drain marker proving the synthetic handlers actually ran.

The note count defaults to 200 and is overridable via `RENAME_DELETE_PERF_VAULT_NOTE_COUNT` for a quicker (smaller) or harsher (larger) run.

> The integration tests run the built bundle in `dist/build`, not `node_modules`. Run `npm run build` first after any source or `obsidian-dev-utils` change, or they silently exercise the stale bundle.

### The rename/delete regression suites, and how they were ported

Seven suites came from `obsidian-custom-attachment-location` when it stopped registering a rename/delete handler (`T881-P40`); each pins a real reported issue against that plugin's tracker, and each one's header names its issue. Six landed as files, the seventh was folded into an existing one:

| Suite | Pins |
| --- | --- |
| `rename-alias-refresh.cross-platform` | #20 — an alias equal to the old base name is refreshed to the new one |
| `canvas-attachment-move.cross-platform` | #22 — moving a `.canvas` moves an attachment found via its own references |
| `canvas-partial-write-guard.cross-platform` | #45 — a partial `.canvas` is never written back to disk |
| `foreign-locked-folder-swap.desktop` | #49 — every rename of another plugin's locked transaction is left alone |
| `note-move-many-attachments.desktop` | #60 — moving a note leaves every embed resolving, at 3 and at 30 |
| `note-move-concurrent-edit.desktop` | #60 — and still does when an outside edit lands mid-rename |
| `native-link-update-fallback.cross-platform` | #47 — its first case absorbed the phantom-old-path assertion |

Three substitutions were forced, and they are the things to preserve when editing any of them:

- **Settings go in through `plugin.api.migrateSettings` and its approval dialog**, not by assignment. The originals walked the owning plugin's component tree to find a live settings object; this plugin's only public write path is that API, so every suite carries the same `applySettings` helper (an `evalInObsidian` callback is serialized, so it cannot share one).
- **The attachment folder is Obsidian's own `attachmentFolderPath` vault config**, not the owning plugin's setting, and there is no equivalent of its per-note `${noteFileName}` token. So the ported scenarios use a SHARED `./assets` folder, and the note-move suites **move the note to another folder** rather than renaming it in place — that is what relocates a shared attachment folder, and (under `newLinkFormat: 'absolute'`) what makes each rewritten link change length so the links after it shift. The alternative, kept in reserve, is the `app.vault.getAvailablePathForAttachments.extended` stub the performance suite uses as a stand-in for that plugin.
- **Locks come from `lib.ResourceLockComponent`**, not from the library's realm-global bag: `lockForPath({ mode: 'subtree' })` under a foreign plugin id, and `isLockedByAncestorForPath` to report a rename's lock coverage.

Four of the seven were `it.skip` in their old home, for a shared-instance `renameFile`/`onCleanCache` stall in that plugin's much larger desktop aggregate. **None of them is skipped here** — measured, not assumed: the whole desktop aggregate runs 12 files / 17 tests in ~30s. The single remaining `it.skip` is documentation, in `canvas-partial-write-guard`, for the Advanced Canvas mid-initialization race that cannot be staged headlessly; it carries the manual recipe.

Two measurements worth keeping, because they contradict what the originals' comments claimed:

- `note-move-many-attachments` **does** reproduce its defect here (both sizes go red when `getLinkIdentityKey` is swapped for a position-bearing key), where in its old home it did not. Moving to a much longer destination folder is enough on its own; no second plugin needed.
- `foreign-locked-folder-swap` **cannot** be broken from this repo: neutralizing this plugin's own foreign-lock skip in `handleRename` leaves it green, because both fixes it guards are `obsidian-dev-utils`'. It is a consumer-side guard over library behavior. Its lock-coverage assertion is live all the same — weakening the transaction's locks to `mode: 'file'` fails it, naming the three uncovered steps.

`scripts/vitest-config.ts` raises the desktop transport's `commandTimeoutInMilliseconds` to 240s for these. A whole `evalInObsidian` callback is ONE `Runtime.evaluate`, and the transport's 30s default kills a longer one while vitest is still waiting — reported as `CDP command timed out ... Runtime.evaluate`, naming neither the pending `waitUntil` nor the assertion that never ran.

### The rescue-ambiguity dialog asks once per deletion, because the two asks OVERLAP

`src/shared-attachment-tie.cross-platform.integration.test.ts` pins the dialog that opens when several notes could adopt a stranded attachment and `notePriorities` names no single owner (OCAL #71). Two things about it are easy to break:

- **It sets `attachmentFolderPath: './assets'`, a PER-NOTE subfolder, not a shared one.** With a shared folder both tied notes resolve to the same destination, the rescue is a no-op either way, and the test passes without proving anything.
- **It starts `trashFile` WITHOUT awaiting it**, waits for `.rescue-ambiguity-reason` to appear, clicks a button, and only then races `flushQueue()` against a second dialog. Awaiting the deletion first would deadlock — the deletion is what is waiting for the answer.

The deadlock that shaped `src/rescue-decision-scope.ts` is worth not re-deriving. `getRescuePath` is asked **twice** about one attachment in a folder deletion, and the asks **overlap**: `replayFolderDeletion` (not queued) deletes the owning note first, which enqueues that note's own `DeleteHandler`; the replay then reaches the attachment and awaits a dialog, and while it awaits, the ODU queue runs the handler it just produced, which walks the deleted note's links back to the same attachment and asks again. Two dialogs open over one file, the user answers one, and the deletion never finishes. **A map of finished answers cannot fix this** — at the moment the second ask arrives there is no finished answer to find. So `RescueDecisionScope.resolveDecision` shares the *pending promise*: the second caller joins the first question. The scope's in-flight counter is entered **synchronously at enqueue time**, not inside the queued operation, which is what holds it above zero across the gap between the replay ending and the queue starting.

It lives in its own module rather than in `src/rename-delete-handler-component.ts` only because that file sits inside a `/* v8 ignore */` region and coverage is enforced at 100%.

A blocking modal inside a queued delete is safe: `addToQueue` passes `pluginNoticeComponent: null` to `runWithTimeoutNotice`, so the 60s timeout resolves to `onTimeoutWithoutNotice` — a debug log, no notice, and **no abort**.

## Deviations from the shared plugin architecture (G51)

- **`src/rename-delete-handler-component.ts` is a copy of the same file in `obsidian-dev-utils`, not an import.** This plugin owns the rename/delete implementation; the library keeps its copy only until the five plugins that still import it have shipped versions that do not, at which point ODU's copy is deleted. Until then the two files exist side by side and a fix has to be applied to whichever one is still live. The copy differs from ODU's deliberately: the registry registration, the multi-plugin settings merge and the `shouldInvokeHandler` election are all removed, because there is exactly one contributor here.
- **English-only, with no `i18next`.** The copied handler's translation calls became plain template literals. A plugin that later needs translations reinstates `t` from `obsidian-dev-utils/obsidian/i18n/i18n` AND an `src/i18n/i18next.d.ts` augmenting `CustomTypeOptions` — ODU's `t` alone does not type-check the selector form, because the augmentation lives in ODU's compilation rather than its published types.
- **`semver` is a direct dependency**, used at runtime by `src/conflicting-plugins.ts` to compare an installed plugin's manifest version against the first version that no longer conflicts. Same use as in `obsidian-custom-attachment-location`.
- **The integration projects seed `obsidian-dev-utils`' integration-test harness plugin alongside the plugin under test**, so an `evalInObsidian` closure reaches the whole library surface as `lib.<helper>` rather than only the harness's own helpers. The suppression suites need `lib.ResourceLockComponent` and `lib.flushQueue` to stage a foreign locked transaction and drain the handler's queue. Wired in two ways, because the projects do not share one path: `scripts/vitest-config.ts`'s `editContext` gives every project the `obsidian-dev-utils/integration-test-setup` setup file, and points `desktop` and `android` at `obsidian-dev-utils/integration-test-vitest-global-setup`, where the global setup **replaces** `obsidian-integration-testing/vitest-global-setup-plugin` (it does everything that one does, plus the seeding — listing both would create the vault twice). The two projects that bring their own `populate` — `integration-tests:demo-vault` and `integration-tests:desktop-performance` — keep their own `globalSetup` (`scripts/demo-vault-global-setup.ts`, `scripts/vitest-global-setup-performance.ts`) and compose `getIntegrationTestPluginPopulate()` and `OBSIDIAN_DEV_UTILS_INTEGRATION_TEST_PLUGIN_ID` in by hand instead. Seeding the harness needs `obsidian-dev-utils` at 96.5.1 or above: earlier bundles pulled `adm-zip` in eagerly, whose top-level `require('crypto')` throws on mobile and aborts the whole `integration-tests:android` project's setup.
