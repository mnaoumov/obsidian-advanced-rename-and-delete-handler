import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * The other deliberate hole in `FileManagerRunAsyncLinkUpdatePatchComponent`'s suppression of Obsidian's
 * native link update: with "Update links" off, the handler still runs — it renames and moves attachments —
 * but rewrites no links itself, so it must leave Obsidian's own link update armed. Discarding it there would
 * strand every link the rename invalidated, which is what the issue reported.
 *
 * See https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/47.
 *
 * The first case also carries the phantom-registration assertion from the issue-#47 suite
 * `obsidian-custom-attachment-location` handed over — that suite drove this same combination and asserted
 * this same rewrite, so the mechanism was folded in here rather than landed as a second copy of it.
 *
 * Ported from `obsidian-dev-utils`' own suite for the reason set out in
 * `foreign-lock-non-interference.cross-platform.integration.test.ts`: this plugin ships a FORK of
 * `rename-delete-handler-component.ts`, so the library's copy of this test guards different code. Each case
 * repeats its own settings helper because an `evalInObsidian` callback is serialized and reaches nothing
 * outside itself.
 *
 * Cross-platform: renaming with "Update links" off has to keep links intact on a phone too, and the manifest
 * declares `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface AttachmentRenameResult extends NativeLinkUpdateResult {
  readonly isOldAttachmentPathReregistered: boolean;
}

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

interface NativeLinkUpdateResult {
  readonly referencingNoteContent: string;
}

interface PluginWithApiLike {
  readonly api: MigrationApiLike;
}

describe('With "Update links" off, Obsidian\'s own link update', () => {
  it('still rewrites the embed when an attachment is renamed', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<AttachmentRenameResult> {
        const FOLDER = 'rdh-attachment-rename';
        const NOTE = `${FOLDER}/note.md`;
        const OLD_ATTACHMENT = `${FOLDER}/attachments/img.png`;
        const NEW_ATTACHMENT = `${FOLDER}/attachments/renamed.png`;
        const WAIT_TIMEOUT_IN_MILLISECONDS = 30_000;
        // Short enough to catch the phantom window below, which is only open across a couple of awaits.
        const PHANTOM_SAMPLE_INTERVAL_IN_MILLISECONDS = 5;

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

        const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');
        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          app.vault.setConfig('attachmentFolderPath', './attachments');
          // Obsidian only rewrites links without prompting when this is on; the prompt would block the headless run.
          app.vault.setConfig('alwaysUpdateLinks', true);

          // The issue's combination: the handler still runs — it renames attachment files — but delegates every link rewrite to Obsidian.
          await applySettings({
            shouldHandleRenames: false,
            shouldRenameAttachmentFiles: true
          });

          await app.vault.createFolder(`${FOLDER}/attachments`);
          await app.vault.createBinary(OLD_ATTACHMENT, new ArrayBuffer(8));
          const note = await app.vault.create(NOTE, `![[${OLD_ATTACHMENT}]]\n`);

          await waitUntil({
            message: 'note embed indexed by the metadata cache',
            predicate: () => (app.metadataCache.getFileCache(note)?.embeds?.length ?? 0) > 0,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const attachment = app.vault.getFileByPath(OLD_ATTACHMENT);
          if (!attachment) {
            throw new Error(`Attachment ${OLD_ATTACHMENT} not found.`);
          }

          /*
           * The MECHANISM behind the issue, sampled while the rename runs: once the attachment has landed at
           * its new path, the OLD path must never reappear in `vault.fileMap`. Obsidian snapshots each link's
           * resolved paths before a rename and rewrites only those that resolve differently afterwards, so a
           * phantom file re-registered at the old path makes it conclude "unchanged" and skip the rewrite —
           * and nobody updates the link. The window is only open across a couple of awaits, which a short
           * sampling interval is enough to catch.
           */
          let isOldAttachmentPathReregistered = false;
          const phantomSampleIntervalId = window.setInterval(() => {
            // Only meaningful once the rename has landed; before that the old path legitimately exists.
            if (!app.vault.getAbstractFileByPath(NEW_ATTACHMENT)) {
              return;
            }

            if (Object.hasOwn(app.vault.fileMap, OLD_ATTACHMENT)) {
              isOldAttachmentPathReregistered = true;
            }
          }, PHANTOM_SAMPLE_INTERVAL_IN_MILLISECONDS);

          try {
            await app.fileManager.renameFile(attachment, NEW_ATTACHMENT);
            // Obsidian's link update and the handler's own queued work both settle after the rename resolves.
            await flushQueue();
            await waitUntil({
              message: 'renamed attachment indexed by the metadata cache',
              predicate: () => app.vault.getAbstractFileByPath(NEW_ATTACHMENT) !== null,
              timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
            });
          } finally {
            window.clearInterval(phantomSampleIntervalId);
          }

          return {
            isOldAttachmentPathReregistered,
            referencingNoteContent: await app.vault.read(note)
          };
        } finally {
          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
          // Back to the defaults declared in `src/plugin-settings.ts`, so the next suite starts where this one found things.
          await applySettings({
            shouldHandleRenames: true,
            shouldRenameAttachmentFiles: false
          });
          /*
           * Through the adapter, as the conflicting-plugin suite does: a fixture teardown must not travel
           * back through the very delete path this plugin patches, which would make the cleanup part of
           * what is under test.
           */
          if (await app.vault.adapter.exists(FOLDER)) {
            await app.vault.adapter.rmdir(FOLDER, true);
          }
        }
      },
      input: {
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    /*
     * The mechanism, ported with the regression suites the owning plugin handed over: once the rename has
     * landed, nothing may re-register the OLD path, or Obsidian's post-rename check still resolves it,
     * concludes the link needs no rewrite, and leaves it pointing at a file that is no longer there.
     */
    expect(result.isOldAttachmentPathReregistered).toBe(false);

    expect(result.referencingNoteContent).toContain('renamed.png');
    expect(result.referencingNoteContent).not.toContain('img.png');
  });

  it('still rewrites the backlink when a note is renamed', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<NativeLinkUpdateResult> {
        const FOLDER = 'rdh-note-rename';
        const OLD_NOTE = `${FOLDER}/note.md`;
        const NEW_NOTE = `${FOLDER}/renamed-note.md`;
        const REFERENCING_NOTE = `${FOLDER}/referencing-note.md`;
        const ATTACHMENT = `${FOLDER}/attachments/img.png`;
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

        const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');
        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          app.vault.setConfig('attachmentFolderPath', './attachments');
          app.vault.setConfig('alwaysUpdateLinks', true);

          await applySettings({
            shouldHandleRenames: false,
            shouldRenameAttachmentFolder: true
          });

          await app.vault.createFolder(`${FOLDER}/attachments`);
          await app.vault.createBinary(ATTACHMENT, new ArrayBuffer(8));
          // The renamed note owns an attachment, so the handler reaches the attachment-folder lookup that registers the phantom old note.
          const note = await app.vault.create(OLD_NOTE, `![[${ATTACHMENT}]]\n`);
          const referencingNote = await app.vault.create(REFERENCING_NOTE, `[[${OLD_NOTE}]]\n`);

          await waitUntil({
            message: 'backlink to the renamed note indexed by the metadata cache',
            predicate: () =>
              (app.metadataCache.getFileCache(referencingNote)?.links?.length ?? 0) > 0
              && (app.metadataCache.getFileCache(note)?.embeds?.length ?? 0) > 0,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          await app.fileManager.renameFile(note, NEW_NOTE);
          await flushQueue();
          await waitUntil({
            message: 'renamed note indexed by the metadata cache',
            predicate: () => app.vault.getAbstractFileByPath(NEW_NOTE) !== null,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          return { referencingNoteContent: await app.vault.read(referencingNote) };
        } finally {
          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
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
          if (await app.vault.adapter.exists(FOLDER)) {
            await app.vault.adapter.rmdir(FOLDER, true);
          }
        }
      },
      input: {
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    expect(result.referencingNoteContent).toContain('renamed-note');
  });
});
