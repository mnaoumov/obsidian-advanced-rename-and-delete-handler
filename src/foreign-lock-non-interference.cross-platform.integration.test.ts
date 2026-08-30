import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * One of the two deliberate holes in `FileManagerRunAsyncLinkUpdatePatchComponent`'s suppression of
 * Obsidian's native link update, driven end to end: a rename performed inside a FOREIGN plugin's in-flight
 * subtree-locked transaction (Advanced Note Composer's folder merge being the real case) belongs to that
 * transaction, which owns its own link and attachment consistency. This handler stays out of it entirely —
 * it neither moves the attachment nor suppresses the native update, because suppressing an update it is not
 * replacing would leave the links dangling.
 *
 * See https://github.com/mnaoumov/obsidian-advanced-note-composer/issues/146.
 *
 * Ported from `obsidian-dev-utils`' own suite, which guards the library's copy of the handler. This plugin
 * ships a FORK of `rename-delete-handler-component.ts` (see AGENTS.md), so the library's test proves nothing
 * about the code that actually runs here — hence this one. It differs from the original in exercising the
 * SHIPPED plugin rather than a hand-built component: the settings go in through the plugin's own
 * `migrateSettings` API, which is the only public way to write them.
 *
 * Cross-platform: a foreign plugin holds locks on a phone too, and the manifest declares
 * `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';
const FOREIGN_PLUGIN_ID = 'rdh-foreign-plugin';

interface ForeignLockResult {
  readonly hasDestinationAttachment: boolean;
  readonly hasSrcAttachment: boolean;
}

interface MigratableSettingsLike {
  readonly shouldHandleRenames?: boolean;
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

interface PluginWithApiLike {
  readonly api: MigrationApiLike;
}

describe('A rename inside a foreign plugin\'s locked transaction', () => {
  it('is left alone by this plugin, native link update and all', async () => {
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
      }): Promise<ForeignLockResult> {
        const SRC_FOLDER = 'rdh-foreign-src';
        const DST_FOLDER = 'rdh-foreign-dst';
        const SRC_NOTE = `${SRC_FOLDER}/note.md`;
        const DST_NOTE = `${DST_FOLDER}/note.md`;
        const SRC_ATTACHMENT = `${SRC_FOLDER}/attachments/img.png`;
        const DST_ATTACHMENT = `${DST_FOLDER}/attachments/img.png`;
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
         * A proposal that matches what the plugin already holds resolves with no dialog at all, so the
         * wait below settles on either outcome rather than insisting on a modal that may never appear.
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

        const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');

        /*
         * A foreign plugin mirroring Advanced Note Composer's folder merge, holding a subtree lock over both
         * folders for the duration of its own rename. A plain subtree lock is enough: the behavior keys off
         * the lock's presence, not off whether it also blocks mutations. The component's unload releases
         * every lock it holds.
         */
        const foreignResourceLockComponent = new ResourceLockComponent(app, foreignPluginId);

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          app.vault.setConfig('attachmentFolderPath', './attachments');

          // The Custom Attachment Location configuration from the issue: move attachments with the note, do not update links.
          await applySettings({
            shouldHandleRenames: false,
            shouldRenameAttachmentFolder: true
          });

          foreignResourceLockComponent.load();

          await app.vault.createFolder(`${SRC_FOLDER}/attachments`);
          await app.vault.createFolder(DST_FOLDER);
          await app.vault.createBinary(SRC_ATTACHMENT, new ArrayBuffer(8));
          const note = await app.vault.create(SRC_NOTE, `![[${SRC_ATTACHMENT}]]\n`);

          await waitUntil({
            message: 'note embed indexed by the metadata cache',
            predicate: () => (app.metadataCache.getFileCache(note)?.embeds?.length ?? 0) > 0,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          foreignResourceLockComponent.lockForPath({ mode: 'subtree', operationName: 'Foreign merge', pathOrFile: SRC_FOLDER });
          foreignResourceLockComponent.lockForPath({ mode: 'subtree', operationName: 'Foreign merge', pathOrFile: DST_FOLDER });

          await app.fileManager.renameFile(note, DST_NOTE);
          /*
           * The handler schedules its attachment move onto the shared sequential queue synchronously from
           * the `rename` event (already fired by the time `renameFile` resolves), so draining that queue
           * deterministically drains any work it might have scheduled. It schedules none here, because the
           * rename happens under the foreign subtree lock; without that guard, the queued handler would move
           * the attachment before this resolves.
           */
          await flushQueue();

          return {
            hasDestinationAttachment: app.vault.getAbstractFileByPath(DST_ATTACHMENT) !== null,
            hasSrcAttachment: app.vault.getAbstractFileByPath(SRC_ATTACHMENT) !== null
          };
        } finally {
          foreignResourceLockComponent.unload();
          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
          // Back to the defaults declared in `src/plugin-settings.ts`, so the next suite starts where this one found things.
          await applySettings({
            shouldHandleRenames: true,
            shouldRenameAttachmentFolder: true
          });
          /*
           * Through the adapter, as the conflicting-plugin suite does: a fixture teardown must not travel
           * back through the very delete path this plugin patches, which would make the cleanup part of
           * what is under test.
           */
          for (const folderPath of [SRC_FOLDER, DST_FOLDER]) {
            if (await app.vault.adapter.exists(folderPath)) {
              await app.vault.adapter.rmdir(folderPath, true);
            }
          }
        }
      },
      input: {
        foreignPluginId: FOREIGN_PLUGIN_ID,
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    // The foreign transaction owns its own consistency, so the handler stays out of the way: the attachment does not move.
    expect(result.hasDestinationAttachment).toBe(false);
    expect(result.hasSrcAttachment).toBe(true);
  });
});
