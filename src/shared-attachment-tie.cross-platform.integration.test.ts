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
 * Deleting a folder whose attachment two OUTSIDE notes still reference leaves the plugin with nothing to
 * decide: one surviving note wins outright, but two of equal rank tie, and the priority list names no
 * owner. Before this suite's feature the attachment was simply kept — which also kept the folder holding
 * it, so the deletion the user asked for silently did not happen and they were told neither which notes
 * were responsible nor why.
 *
 * See https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/71.
 *
 * The dialog answers both halves: it names the tied notes, states the reason, and turns the answer into
 * one click that moves the attachment and frees the folder to go.
 *
 * Two things are worth stating about the staging:
 *
 * - `attachmentFolderPath` is `./assets`, a subfolder of each note's OWN folder rather than the shared
 *   `./assets` the ported rename suites use. A tie is only observable when the two candidates resolve to
 *   DIFFERENT destinations; with one shared folder the rescue would be a no-op whichever note won.
 * - `alwaysUpdateLinks` is on, because the rescue moves a file through `app.fileManager.renameFile` and
 *   Obsidian would otherwise raise its own confirmation modal — which a headless run cannot answer, and
 *   which would be indistinguishable from the dialog under test.
 *
 * The second assertion in the first case is the one that pins the decision scope:
 * `getRescuePath` is called TWICE for a folder deletion, once by the replay and once by the owning note's
 * own deletion, and without the scope the user is asked the same question twice.
 *
 * Cross-platform: a shared attachment ties on a phone as readily as on a desktop, and the manifest
 * declares `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface LeaveItResult {
  readonly doesAttachmentStillExistWhereItWas: boolean;
  readonly doesDeletedFolderStillExist: boolean;
  readonly isSecondDialogOpen: boolean;
}

interface MigratableSettingsLike {
  readonly notePriorities?: readonly string[];
  readonly shouldHandleDeletions?: boolean;
  readonly shouldHandleRenames?: boolean;
  readonly shouldRescueSharedAttachments?: boolean;
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

interface PickNoteResult {
  readonly attachmentPathAfter: null | string;
  readonly buttonTexts: string[];
  readonly doesDeletedFolderStillExist: boolean;
  readonly isSecondDialogOpen: boolean;
  readonly reasonText: string;
}

interface PluginWithApiLike {
  readonly api: MigrationApiLike;
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

describe('Deleting a folder whose attachment two outside notes tie over', () => {
  it('moves the attachment into the note the user picks, and then deletes the folder', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<PickNoteResult> {
        const ROOT = 'rdh-tie-pick';
        const DELETED_FOLDER = `${ROOT}/deleted`;
        const OWNER = `${DELETED_FOLDER}/Owner.md`;
        const ATTACHMENT = `${DELETED_FOLDER}/assets/image.png`;
        const FIRST_SURVIVOR = `${ROOT}/a/A.md`;
        const SECOND_SURVIVOR = `${ROOT}/b/B.md`;
        const RESCUED_ATTACHMENT = `${ROOT}/a/assets/image.png`;
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

        /**
         * Writes settings through the plugin's own migration API and approves the dialog it raises.
         *
         * @param proposedSettings - The settings to write.
         */
        async function applySettings(proposedSettings: MigratableSettingsLike): Promise<void> {
          const migrationPromise = api.migrateSettings({
            proposedSettings,
            sourcePluginId
          });
          let isSettled = false;
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

        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');
        const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');

        // Everything that mutates shared state sits inside the `try`, so the `finally` puts the vault back however this ends.
        try {
          app.vault.setConfig('alwaysUpdateLinks', true);
          // A subfolder of each note's OWN folder, so the two tied notes resolve to different destinations.
          app.vault.setConfig('attachmentFolderPath', './assets');

          await applySettings({
            // `.md` against `.md` is the reporter's own worked example, and the only entry that ties here.
            notePriorities: ['.md'],
            shouldHandleDeletions: true,
            shouldHandleRenames: true,
            shouldRescueSharedAttachments: true
          });

          await app.vault.createFolder(`${DELETED_FOLDER}/assets`);
          await app.vault.createFolder(`${ROOT}/a`);
          await app.vault.createFolder(`${ROOT}/b`);
          const attachment = await app.vault.createBinary(ATTACHMENT, new ArrayBuffer(8));
          await app.vault.create(OWNER, `![[${ATTACHMENT}]]\n`);
          await app.vault.create(FIRST_SURVIVOR, `![[${ATTACHMENT}]]\n`);
          await app.vault.create(SECOND_SURVIVOR, `![[${ATTACHMENT}]]\n`);

          await waitUntil({
            message: 'all three references to the attachment are indexed',
            predicate: () => app.metadataCache.getBacklinksForFile(attachment).keys().length === 3,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const deletedFolder = app.vault.getFolderByPath(DELETED_FOLDER);
          if (!deletedFolder) {
            throw new Error(`${DELETED_FOLDER} was not created`);
          }

          /*
           * Deliberately not awaited yet: the deletion blocks on the dialog it is about to raise, which is
           * the whole point of this suite.
           */
          const deletionPromise = app.fileManager.trashFile(deletedFolder);
          let isDeletionSettled = false;
          const deletionSettlementPromise = deletionPromise
            .then(() => {
              isDeletionSettled = true;
            })
            .catch(() => {
              isDeletionSettled = true;
            });

          await waitUntil({
            message: 'the plugin asks which note adopts the attachment',
            predicate: () => isDeletionSettled || document.querySelector('.rescue-ambiguity-reason') !== null,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const dialogEl = document.querySelector('.modal-container');
          if (!dialogEl) {
            throw new Error('the plugin did not ask which note adopts the attachment');
          }

          const reasonText = dialogEl.querySelector('.rescue-ambiguity-reason')?.textContent ?? '';
          const buttons = [...dialogEl.querySelectorAll('button')];
          const buttonTexts = buttons.map((button) => button.textContent);

          const adoptButton = buttons.find((button) => button.textContent === 'Move to A.md');
          if (!adoptButton) {
            throw new Error(`the dialog offers no way to pick A.md, only: ${buttonTexts.join(', ')}`);
          }

          adoptButton.click();

          await deletionSettlementPromise;
          await deletionPromise;

          /*
           * The owning note's own deletion is reported after the replay and re-walks its links, so this
           * drain is where a second, unwanted dialog would appear. Racing the drain against that dialog
           * settles either way rather than hanging on the one this suite is trying to prove absent.
           */
          let didQueueDrain = false;
          const drainPromise = flushQueue()
            .then(() => {
              didQueueDrain = true;
            })
            .catch(() => {
              didQueueDrain = true;
            });

          await waitUntil({
            message: 'the deletion finishes without asking a second time',
            predicate: () => didQueueDrain || document.querySelector('.rescue-ambiguity-reason') !== null,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const isSecondDialogOpen = document.querySelector('.rescue-ambiguity-reason') !== null;
          if (isSecondDialogOpen) {
            // Dismissed so the drain can finish and the fixture teardown below is reachable.
            const leaveButton = [...document.querySelectorAll<HTMLButtonElement>('.modal-container button')]
              .find((button) => button.textContent === 'Leave it here');
            leaveButton?.click();
          }

          await drainPromise;

          return {
            attachmentPathAfter: app.vault.getFileByPath(RESCUED_ATTACHMENT)?.path ?? null,
            buttonTexts,
            doesDeletedFolderStillExist: app.vault.getFolderByPath(DELETED_FOLDER) !== null,
            isSecondDialogOpen,
            reasonText
          };
        } finally {
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
          /*
           * Through the adapter: a fixture teardown must not travel back through the very delete path this
           * plugin patches, which would make the cleanup part of what is under test.
           */
          if (await app.vault.adapter.exists(ROOT)) {
            await app.vault.adapter.rmdir(ROOT, true);
          }
        }
      },
      input: {
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    // One button per tied note, named after it, plus the way out.
    expect(result.buttonTexts).toEqual(['Move to A.md', 'Move to B.md', 'Leave it here']);

    // The real cause, not just "several notes reference this".
    expect(result.reasonText).toContain('tie');
    expect(result.reasonText).toContain('Note priorities');

    // The attachment went to the note the user picked...
    expect(result.attachmentPathAfter).toBe('rdh-tie-pick/a/assets/image.png');
    // ...which is what finally lets the folder the user asked to delete actually go.
    expect(result.doesDeletedFolderStillExist).toBe(false);

    // And the same question was put exactly once, though the hook was called twice.
    expect(result.isSecondDialogOpen).toBe(false);
  });

  it('keeps the attachment, and the folder holding it, when the user declines to pick', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<LeaveItResult> {
        const ROOT = 'rdh-tie-leave';
        const DELETED_FOLDER = `${ROOT}/deleted`;
        const OWNER = `${DELETED_FOLDER}/Owner.md`;
        const ATTACHMENT = `${DELETED_FOLDER}/assets/image.png`;
        const FIRST_SURVIVOR = `${ROOT}/a/A.md`;
        const SECOND_SURVIVOR = `${ROOT}/b/B.md`;
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

        /**
         * Writes settings through the plugin's own migration API and approves the dialog it raises.
         *
         * @param proposedSettings - The settings to write.
         */
        async function applySettings(proposedSettings: MigratableSettingsLike): Promise<void> {
          const migrationPromise = api.migrateSettings({
            proposedSettings,
            sourcePluginId
          });
          let isSettled = false;
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

        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');
        const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');

        try {
          app.vault.setConfig('alwaysUpdateLinks', true);
          app.vault.setConfig('attachmentFolderPath', './assets');

          await applySettings({
            notePriorities: ['.md'],
            shouldHandleDeletions: true,
            shouldHandleRenames: true,
            shouldRescueSharedAttachments: true
          });

          await app.vault.createFolder(`${DELETED_FOLDER}/assets`);
          await app.vault.createFolder(`${ROOT}/a`);
          await app.vault.createFolder(`${ROOT}/b`);
          const attachment = await app.vault.createBinary(ATTACHMENT, new ArrayBuffer(8));
          await app.vault.create(OWNER, `![[${ATTACHMENT}]]\n`);
          await app.vault.create(FIRST_SURVIVOR, `![[${ATTACHMENT}]]\n`);
          await app.vault.create(SECOND_SURVIVOR, `![[${ATTACHMENT}]]\n`);

          await waitUntil({
            message: 'all three references to the attachment are indexed',
            predicate: () => app.metadataCache.getBacklinksForFile(attachment).keys().length === 3,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const deletedFolder = app.vault.getFolderByPath(DELETED_FOLDER);
          if (!deletedFolder) {
            throw new Error(`${DELETED_FOLDER} was not created`);
          }

          const deletionPromise = app.fileManager.trashFile(deletedFolder);
          let isDeletionSettled = false;
          const deletionSettlementPromise = deletionPromise
            .then(() => {
              isDeletionSettled = true;
            })
            .catch(() => {
              isDeletionSettled = true;
            });

          await waitUntil({
            message: 'the plugin asks which note adopts the attachment',
            predicate: () => isDeletionSettled || document.querySelector('.rescue-ambiguity-reason') !== null,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const dialogEl = document.querySelector('.modal-container');
          if (!dialogEl) {
            throw new Error('the plugin did not ask which note adopts the attachment');
          }

          const leaveButton = [...dialogEl.querySelectorAll('button')].find((button) => button.textContent === 'Leave it here');
          if (!leaveButton) {
            throw new Error('the dialog offers no way to leave the attachment alone');
          }

          leaveButton.click();

          await deletionSettlementPromise;
          await deletionPromise;

          /*
           * A decline is an answer like any other, so it too has to survive into the owning note's own
           * deletion — otherwise the user is asked again about the file they just chose to leave alone.
           */
          let didQueueDrain = false;
          const drainPromise = flushQueue()
            .then(() => {
              didQueueDrain = true;
            })
            .catch(() => {
              didQueueDrain = true;
            });

          await waitUntil({
            message: 'the deletion finishes without asking a second time',
            predicate: () => didQueueDrain || document.querySelector('.rescue-ambiguity-reason') !== null,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const isSecondDialogOpen = document.querySelector('.rescue-ambiguity-reason') !== null;
          if (isSecondDialogOpen) {
            const secondLeaveButton = [...document.querySelectorAll<HTMLButtonElement>('.modal-container button')]
              .find((button) => button.textContent === 'Leave it here');
            secondLeaveButton?.click();
          }

          await drainPromise;

          return {
            doesAttachmentStillExistWhereItWas: app.vault.getFileByPath(ATTACHMENT) !== null,
            doesDeletedFolderStillExist: app.vault.getFolderByPath(DELETED_FOLDER) !== null,
            isSecondDialogOpen
          };
        } finally {
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
          if (await app.vault.adapter.exists(ROOT)) {
            await app.vault.adapter.rmdir(ROOT, true);
          }
        }
      },
      input: {
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    // Declining is the conservative answer, and it is honoured: nothing moves and nothing is lost.
    expect(result.doesAttachmentStillExistWhereItWas).toBe(true);
    expect(result.doesDeletedFolderStillExist).toBe(true);

    // A decline is remembered for the rest of the deletion, exactly as a pick is.
    expect(result.isSecondDialogOpen).toBe(false);
  });
});
