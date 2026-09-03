import { evalInObsidian } from 'obsidian-integration-testing';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { PluginSettingsSnapshot } from './settings-snapshot.integration-helper.ts';

import {
  readPluginSettings,
  writePluginSettings
} from './settings-snapshot.integration-helper.ts';

/*
 * A whole folder swap owned by another plugin is left alone, rename by rename.
 *
 * See https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/49 ("Attachments get renamed
 * when Advanced Note Composer swaps two folders"). The reporter swapped folder `B` with its own parent `A`
 * through Advanced Note Composer's "Swap folder with...", and both notes came back de-duplicated:
 * `A/Overview.md` and `A/B/Overview.md` landed as `B/A/Overview 1.md` and `B/Overview 1.md`, so every link
 * to them dangled.
 *
 * The de-duplication is the fingerprint. Advanced Note Composer renames through `renameSafe`, which asks for
 * another name whenever the destination is occupied — and the destination was only ever "occupied" because
 * the rename handler re-registered a phantom file at the OLD path while the next rename was picking a name.
 *
 * Advanced Note Composer does take `subtree` locks on both folders for the whole swap, and this handler does
 * skip a rename covered by such a lock. The guard missed because the lock registry is path-keyed and nothing
 * re-keyed it when a locked folder was itself renamed — which is the first thing a folder swap does. After
 * `A/B` -> `A/A` and `A` -> `B`, the live tree reads `B/...` while the lock keys still read `A` and `A/B`, so
 * every later child move looked unlocked and the handler joined in.
 *
 * This suite reproduces that without installing a second plugin: it takes the same `subtree` locks under a
 * foreign plugin id through the shared lock component every plugin bundling the library sees — which is
 * exactly how the guard sees Advanced Note Composer's locks — and then replays that plugin's `swapFolder`
 * sequence verbatim.
 *
 * It pins BOTH halves:
 *   - the symptom — no note may come back with a de-duplicated ` 1` name;
 *   - the mechanism — every rename of the swap must be reported as lock-covered, so a failure names the hole
 *     rather than only the damage;
 * and it runs a control phase first, with the rename handler switched off entirely, to show the replayed
 * sequence is sound on its own: the damage belongs to the handler, not to Advanced Note Composer.
 *
 * Ported from `obsidian-custom-attachment-location`, which deleted the suite when it stopped registering a
 * rename/delete handler. Rewritten rather than copied: the original assigned to a settings object it found by
 * walking the plugin's component tree and reached the lock manager through the library's realm-global bag,
 * while here settings go in through this plugin's `migrateSettings` API — its only public write path — and
 * the locks are taken through `lib.ResourceLockComponent`, the same handle the sibling foreign-lock suite
 * uses.
 *
 * WHAT BREAKS THIS SUITE LIVES IN THE LIBRARY, NOT HERE — measured 2026-09-02. Neutralizing this plugin's
 * own foreign-lock skip in `handleRename` leaves it green, because both fixes it actually guards are
 * `obsidian-dev-utils`': re-keying the lock registry when a locked folder is itself renamed, and dropping the
 * phantom old-path registration that supplied the de-duplication. This plugin is the consumer that proves
 * them, which is the whole reason the suite moved here with the behavior. The lock-coverage assertion is
 * live rather than vacuous: weakening the transaction's locks from `subtree` to `file` turns three of the
 * five steps uncovered and fails it, naming them.
 *
 * Desktop-only: five sequential renames per phase, twice over, and the behavior is platform-independent.
 * The owner's call was to keep the heavy timing-sensitive suites off the Android emulator pass.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';
const FOREIGN_PLUGIN_ID = 'advanced-note-composer';
const SCENARIO_TIMEOUT_IN_MILLISECONDS = 180_000;
const EXPECTED_STEP_COUNT = 5;
const EXPECTED_FINAL_PATHS = ['B/A/Overview.md', 'B/C/Overview.md', 'B/Overview.md'];

interface MigratableSettingsLike {
  readonly shouldHandleRenames?: boolean;
  readonly shouldRenameAttachmentFiles?: boolean;
  readonly shouldRenameAttachmentFolder?: boolean;
}

interface MigrateSettingsParamsLike {
  readonly proposedSettings: MigratableSettingsLike;
  readonly sourcePluginId: string;
}

interface MigrateSettingsResultLike {
  readonly isApplied: boolean;
}

interface MigrationApiLike {
  migrateSettings(params: MigrateSettingsParamsLike): Promise<MigrateSettingsResultLike>;
}

interface PhaseResult {
  readonly finalPaths: readonly string[];
  readonly steps: readonly RenameStep[];
}

interface PluginWithApiLike {
  readonly api: MigrationApiLike;
}

interface RenameStep {
  readonly actualNewPath: string;
  readonly oldPath: string;
  readonly requestedNewPath: string;
  readonly wasCoveredByLock: boolean;
}

interface SwapResult {
  readonly control: PhaseResult;
  readonly reporter: PhaseResult;
}

/*
 * This plugin's settings outlive each test file — one run drives every suite against one Obsidian instance —
 * so what this suite stages must not become the starting point of whichever file the sequencer runs next.
 * Handed back the way the `finally` blocks below hand back `attachmentFolderPath`. See
 * `settings-snapshot.integration-helper.ts`.
 */
let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('A folder swap owned by another plugin', () => {
  it('is left alone by this plugin, rename by rename', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        foreignPluginId,
        lib: {
          flushQueue,
          ResourceLockComponent,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<SwapResult> {
        const CONTROL_ROOT = 'rdh-swap-control';
        const REPORTER_ROOT = 'rdh-swap-reporter';
        const TEMPORARY_FOLDER = 'rdh-swap-temp';
        const WAIT_TIMEOUT_IN_MILLISECONDS = 30_000;

        const plugin = app.plugins.plugins[pluginId];
        if (!plugin) {
          throw new Error(`${pluginId} is not loaded`);
        }

        function hasApi(candidate: object): candidate is PluginWithApiLike {
          return 'api' in candidate;
        }

        if (!hasApi(plugin)) {
          throw new Error(`${pluginId} exposes no API`);
        }

        const api = plugin.api;
        let steps: RenameStep[] = [];

        /**
         * Writes settings through the plugin's own migration API and approves the dialog it raises.
         *
         * A proposal that matches what the plugin already holds resolves with no dialog at all, so the wait
         * settles on either outcome rather than insisting on a modal that may never appear.
         *
         * @param proposedSettings - The settings to write.
         */
        async function applySettings(proposedSettings: MigratableSettingsLike): Promise<void> {
          const migrationPromise = api.migrateSettings({
            proposedSettings,
            sourcePluginId
          });
          let isSettled = false;
          /*
           * Never rejects — the `catch` absorbs it — so awaiting it below keeps it from floating, while the
           * migration's own rejection still surfaces from the `await` that follows.
           */
          const settlementPromise = migrationPromise
            .then(() => {
              isSettled = true;
            })
            .catch(() => {
              isSettled = true;
            });

          await waitUntil({
            message: 'the settings dialog opens, or the proposal turns out to change nothing',
            predicate: () => isSettled || document.querySelector('.modal-container') !== null,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const modalEl = document.querySelector('.modal-container');
          if (modalEl) {
            const okButton = [...modalEl.querySelectorAll('button')].find((button) => button.textContent === 'OK');
            if (!okButton) {
              throw new Error('the settings dialog has no OK button');
            }

            okButton.click();
          }

          await settlementPromise;
          const migrateSettingsResult = await migrationPromise;
          if (!migrateSettingsResult.isApplied) {
            throw new Error('the settings were not applied');
          }
        }

        /**
         * Asks the vault for a free path the way Advanced Note Composer's `renameSafe` does.
         *
         * @param path - The occupied path.
         * @returns A free path near it.
         */
        function getAvailablePath(path: string): string {
          const lastSlashIndex = path.lastIndexOf('/');
          const name = path.slice(lastSlashIndex + 1);
          const lastDotIndex = name.lastIndexOf('.');
          if (lastDotIndex <= 0) {
            return app.vault.getAvailablePath(path, '');
          }

          return app.vault.getAvailablePath(path.slice(0, path.length - (name.length - lastDotIndex)), name.slice(lastDotIndex + 1));
        }

        /**
         * Joins a parent path and a name, tolerating the vault root.
         *
         * @param parentPath - The parent folder's path.
         * @param name - The child's name.
         * @returns The joined path.
         */
        function joinPath(parentPath: string, name: string): string {
          return parentPath === '' ? name : `${parentPath}/${name}`;
        }

        /**
         * Whether the child path lies under the parent one.
         *
         * @param childPath - The candidate child path.
         * @param parentPath - The candidate parent path.
         * @returns `true` when it does.
         */
        function isChildPath(childPath: string, parentPath: string): boolean {
          return childPath.startsWith(`${parentPath}/`);
        }

        const foreignResourceLockComponent = new ResourceLockComponent(app, foreignPluginId);
        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          // Obsidian otherwise asks for confirmation through a modal, which would stall a headless run.
          app.vault.setConfig('alwaysUpdateLinks', true);
          foreignResourceLockComponent.load();

          /*
           * The control phase switches the handler off entirely — with all three off, it returns before it
           * queues anything — so the same sequence under the same locks runs with nobody but the transaction
           * touching the files. The reporter phase is that reporter's own configuration: the plugin steps
           * back from link updating but still follows notes with their attachments, so the handler runs on
           * every note move.
           */
          const control = await runPhase(CONTROL_ROOT, false);
          const reporter = await runPhase(REPORTER_ROOT, true);
          return { control, reporter };
        } finally {
          foreignResourceLockComponent.unload();
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
          // Back to the defaults declared in `src/plugin-settings.ts`, so the next suite starts where this one found things.
          await applySettings({
            shouldHandleRenames: true,
            shouldRenameAttachmentFiles: false,
            shouldRenameAttachmentFolder: true
          });
          /*
           * Through the adapter, as the conflicting-plugin suite does: a fixture teardown must not travel
           * back through the very delete path this plugin patches, which would make the cleanup part of
           * what is under test.
           */
          for (const folderPath of [CONTROL_ROOT, REPORTER_ROOT, TEMPORARY_FOLDER]) {
            if (await app.vault.adapter.exists(folderPath)) {
              await app.vault.adapter.rmdir(folderPath, true);
            }
          }
        }

        /**
         * Renames as Advanced Note Composer does — onto the requested path, or onto a de-duplicated one when
         * it is occupied — recording whether the transaction's locks covered the rename.
         *
         * Recording the lock coverage is what turns a failure into a diagnosis rather than just damage.
         *
         * @param oldPath - The path to rename from.
         * @param newPath - The path to rename to.
         * @returns The path actually landed on.
         */
        async function renameSafe(oldPath: string, newPath: string): Promise<string> {
          const file = app.vault.getAbstractFileByPath(oldPath);
          if (!file) {
            return oldPath;
          }

          const wasCoveredByLock = foreignResourceLockComponent.isLockedByAncestorForPath(oldPath)
            || foreignResourceLockComponent.isLockedByAncestorForPath(newPath);
          const actualNewPath = app.vault.getAbstractFileByPath(newPath) ? getAvailablePath(newPath) : newPath;

          await app.fileManager.renameFile(file, actualNewPath);
          steps.push({
            actualNewPath,
            oldPath,
            requestedNewPath: newPath,
            wasCoveredByLock
          });
          return actualNewPath;
        }

        /**
         * Runs the whole replayed swap once, under the transaction's locks.
         *
         * @param root - The folder the phase's tree is built under.
         * @param isRenameHandlerEnabled - Whether the handler is left able to act on the renames.
         * @returns What the phase left behind, and every rename it made.
         */
        async function runPhase(root: string, isRenameHandlerEnabled: boolean): Promise<PhaseResult> {
          await applySettings({
            shouldHandleRenames: false,
            shouldRenameAttachmentFiles: isRenameHandlerEnabled,
            shouldRenameAttachmentFolder: false
          });
          steps = [];

          // The reporter's tree: `A` holds a note plus the sub-folders swapped with it.
          await app.vault.createFolder(`${root}/A/B`);
          await app.vault.createFolder(`${root}/A/C`);
          await app.vault.create(`${root}/A/Overview.md`, `Test [[${root}/A/B/Overview|Overview]]\n`);
          await app.vault.create(`${root}/A/B/Overview.md`, `B [[${root}/A/Overview|Overview]]\n`);
          await app.vault.create(`${root}/A/C/Overview.md`, `C [[${root}/A/Overview|Overview]]\n`);

          // The handler reads the cache of the note being moved, so let it resolve before swapping.
          await waitUntil({
            message: 'the phase\'s notes are indexed by the metadata cache',
            predicate: () => app.metadataCache.getCache(`${root}/A/Overview.md`) !== null,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          /*
           * Advanced Note Composer locks both folders for the whole transaction under its own plugin id. The
           * guard only asks whether the path is covered, so a foreign id reproduces it exactly — and keeps
           * this suite free of a second installed plugin.
           */
          const lockedPaths = [`${root}/A`, `${root}/A/B`];
          for (const lockedPath of lockedPaths) {
            foreignResourceLockComponent.lockForPath({
              mode: 'subtree',
              operationName: 'Swap folders',
              pathOrFile: lockedPath
            });
          }

          try {
            await swapFolder(`${root}/A/B`, `${root}/A`);
          } finally {
            // Released by path rather than through the returned handles: the locks are reference-counted, and this balances them by the same key they were taken under.
            for (const lockedPath of lockedPaths) {
              foreignResourceLockComponent.unlockForPath(lockedPath);
            }
          }

          // The handler works on a queue of its own, so let any damage it would do land before sampling.
          await flushQueue();

          const finalPaths = app.vault.getFiles()
            .map((file) => file.path)
            .filter((path) => path.startsWith(`${root}/`))
            .map((path) => path.slice(root.length + 1))
            .sort();

          return {
            finalPaths,
            steps
          };
        }

        /**
         * A verbatim replay of Advanced Note Composer 5.3.0's `swapFolder`, with its
         * "swap entire folder structure" option off — the reporter's run, where only the files change place
         * and the sub-folders travel with their renamed parent.
         *
         * The live `TFolder` objects are held across the whole sequence, as that plugin does, so every path
         * passed is the CURRENT one. That matters here, where the target folder is the source's own parent
         * and renaming it moves the source too. The two `…WithSourceName` / `…WithTargetName` values are the
         * exception, because that plugin computes them up front and they do go stale.
         *
         * @param sourceFolderPath - The folder swapped in.
         * @param targetFolderPath - The folder swapped out.
         */
        async function swapFolder(sourceFolderPath: string, targetFolderPath: string): Promise<void> {
          const sourceFolder = app.vault.getFolderByPath(sourceFolderPath);
          const targetFolder = app.vault.getFolderByPath(targetFolderPath);
          if (!sourceFolder || !targetFolder) {
            return;
          }

          const sourceFolderName = sourceFolder.name;
          const targetFolderName = targetFolder.name;

          if (sourceFolderName !== targetFolderName) {
            const sourceFolderWithTargetName = joinPath(sourceFolder.parent?.path ?? '', targetFolderName);
            await renameSafe(sourceFolder.path, sourceFolderWithTargetName);
            const targetFolderWithSourceName = joinPath(targetFolder.parent?.path ?? '', sourceFolderName);
            await renameSafe(targetFolder.path, targetFolderWithSourceName);

            /*
             * Only the source folder can need a second rename: it lands on a de-duplicated name while the
             * target still occupies the slot, then retries once the target has vacated it.
             */
            if (sourceFolder.name !== targetFolderName && !app.vault.getFolderByPath(sourceFolderWithTargetName)) {
              await renameSafe(sourceFolder.path, sourceFolderWithTargetName);
            }
          }

          await app.vault.createFolder(TEMPORARY_FOLDER);

          const sourceChildren = sourceFolder.children.flatMap((child) => app.vault.getFileByPath(child.path) ?? []);
          const targetChildren = targetFolder.children.flatMap((child) => app.vault.getFileByPath(child.path) ?? []);
          const stagedChildren: typeof sourceChildren = [];
          const targetFolderPathBeforeChildren = targetFolder.path;

          for (const sourceChild of sourceChildren) {
            await renameSafe(sourceChild.path, joinPath(TEMPORARY_FOLDER, sourceChild.name));
            stagedChildren.push(sourceChild);
          }

          for (const targetChild of targetChildren) {
            if (isChildPath(targetChild.path, sourceFolder.path)) {
              continue;
            }

            await renameSafe(targetChild.path, joinPath(sourceFolder.path, targetChild.name));
          }

          if (targetFolder.path !== targetFolderPathBeforeChildren) {
            await renameSafe(targetFolder.path, targetFolderPathBeforeChildren);
          }

          for (const stagedChild of stagedChildren) {
            if (!isChildPath(stagedChild.path, TEMPORARY_FOLDER)) {
              continue;
            }

            await renameSafe(stagedChild.path, joinPath(targetFolder.path, stagedChild.name));
          }

          const temporaryFolder = app.vault.getFolderByPath(TEMPORARY_FOLDER);
          if (temporaryFolder) {
            await app.fileManager.trashFile(temporaryFolder);
          }
        }
      },
      input: {
        foreignPluginId: FOREIGN_PLUGIN_ID,
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    // Both phases really ran the whole replayed sequence: two folder renames plus three file moves.
    expect(result.control.steps).toHaveLength(EXPECTED_STEP_COUNT);
    expect(result.reporter.steps).toHaveLength(EXPECTED_STEP_COUNT);

    /*
     * Control: with the handler switched off, the very same sequence under the very same locks lands every
     * file exactly where it was asked to. So the sequence is sound, and anything below belongs to the
     * handler rather than to Advanced Note Composer.
     */
    expect(result.control.steps.filter((step) => step.actualNewPath !== step.requestedNewPath)).toStrictEqual([]);
    expect(result.control.finalPaths).toStrictEqual(EXPECTED_FINAL_PATHS);

    /*
     * The mechanism. The foreign plugin holds a `subtree` lock on both folders for the whole transaction, so
     * NO rename of that transaction may be seen as unlocked — the moment one is, the handler stops skipping
     * and joins in. The locks are path-keyed, and the folder renames that open the swap move both folders
     * out from under their own locks.
     */
    expect(result.reporter.steps.filter((step) => !step.wasCoveredByLock)).toStrictEqual([]);

    // The symptom: nothing may be de-duplicated. A swap moves files, it does not rename them.
    expect(result.reporter.steps.filter((step) => step.actualNewPath !== step.requestedNewPath)).toStrictEqual([]);
    expect(result.reporter.finalPaths).toStrictEqual(EXPECTED_FINAL_PATHS);
  }, SCENARIO_TIMEOUT_IN_MILLISECONDS);
});
