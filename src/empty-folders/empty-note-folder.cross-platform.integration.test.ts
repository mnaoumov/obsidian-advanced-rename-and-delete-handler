import { evalInObsidian } from 'obsidian-integration-testing';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { PluginSettingsSnapshot } from '../settings/settings-snapshot.integration-helper.ts';

import {
  readPluginSettings,
  writePluginSettings
} from '../settings/settings-snapshot.integration-helper.ts';

/*
 * Deleting a note under `Empty folder behavior: Delete` also deleted the folder the note sat in, when the note was the
 * last thing in it. See https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/44: the reporter keeps
 * attachments in a folder of their own and expected only that folder to go.
 *
 * The note's own folder is now deleted only with `shouldDeleteEmptyNoteFolders` on. Both cases run the reporter's
 * staging: one note alone in its folder, one embedded attachment in a separate attachment folder, and a deletion that
 * leaves both folders empty. The attachment folder goes either way, which is what proves the deletion was handled.
 *
 * Cross-platform: the manifest declares `isDesktopOnly: false`, and a note is deleted on a phone as well.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface DeleteNoteInput {
  readonly pluginId: string;
  readonly root: string;
  readonly shouldDeleteEmptyNoteFolders: boolean;
  readonly sourcePluginId: string;
}

interface DeleteNoteResult {
  readonly doesAttachmentFolderExist: boolean;
  readonly doesNoteFolderExist: boolean;
}

interface MigratableSettingsLike {
  readonly emptyFolderBehavior?: string;
  readonly shouldDeleteEmptyNoteFolders?: boolean;
  readonly shouldHandleDeletions?: boolean;
}

interface MigrateSettingsParamsLike {
  readonly proposedSettings: MigratableSettingsLike;
  readonly sourcePluginId: string;
}

interface MigrateSettingsResultLike {
  readonly isApplied: boolean;
}

interface MigrationApiLike {
  migrateSettings: (params: MigrateSettingsParamsLike) => Promise<MigrateSettingsResultLike>;
}

interface ObsidianLibStateLike {
  readonly pluginApiRegistry?: PluginApiRegistryWrapperLike;
}

/**
 * The slice of the `@mnaoumov/obsidian-lib` cross-plugin registry a closure reads the API from: the wire-level path
 * that library's Plugin API protocol guide freezes, so a suite reaches the plugin the way a consumer does.
 */
interface PluginApiRegistryHostLike {
  readonly __obsidianLib?: ObsidianLibStateLike;
}

interface PluginApiRegistryLike {
  readonly records?: Partial<Record<string, readonly PublishedPluginApiRecordLike[]>>;
}

interface PluginApiRegistryWrapperLike {
  readonly value?: PluginApiRegistryLike;
}

interface PublishedPluginApiRecordLike {
  readonly api: MigrationApiLike;
  readonly isRevoked: boolean;
}

/*
 * This plugin's settings outlive each test file — one run drives every suite against one Obsidian instance —
 * so what this suite stages must not become the starting point of whichever file the sequencer runs next.
 * See `settings-snapshot.integration-helper.ts`.
 */
let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

async function runDeleteNote(input: DeleteNoteInput): Promise<DeleteNoteResult> {
  return await evalInObsidian({
    async callback({
      app,
      lib: {
        flushQueue,
        waitUntil
      },
      pluginId,
      root,
      shouldDeleteEmptyNoteFolders,
      sourcePluginId
    }): Promise<DeleteNoteResult> {
      const NOTE_FOLDER = `${root}/Notes`;
      const ATTACHMENT_FOLDER = `${root}/Attachments`;
      const ATTACHMENT = `${ATTACHMENT_FOLDER}/Image.png`;
      /*
       * Under the transport's ~30s per-closure cap, not at it. Three charges: the settings dialog, the index wait
       * and the effect wait. Each lands in well under a second on a vault this size, so 8000 ms apiece sums to
       * 24 000.
       */
      const WAIT_TIMEOUT_IN_MILLISECONDS = 8000;

      const apiRecord = (window as PluginApiRegistryHostLike).__obsidianLib?.pluginApiRegistry?.value?.records?.[pluginId]
        ?.find((candidate) => !candidate.isRevoked);
      if (!apiRecord) {
        throw new Error(`${pluginId} has published no API`);
      }

      const api = apiRecord.api;

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

      const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');

      try {
        app.vault.setConfig('attachmentFolderPath', ATTACHMENT_FOLDER);
        // Saved at once, so a reload of `app.json` mid-case cannot put back a folder the handler would then look for in vain.
        await app.vault.saveConfig();

        await applySettings({
          emptyFolderBehavior: 'Delete',
          shouldDeleteEmptyNoteFolders,
          shouldHandleDeletions: true
        });

        await app.vault.createFolder(NOTE_FOLDER);
        await app.vault.createFolder(ATTACHMENT_FOLDER);
        const attachment = await app.vault.createBinary(ATTACHMENT, new ArrayBuffer(8));
        const note = await app.vault.create(`${NOTE_FOLDER}/Note.md`, `![[${ATTACHMENT}]]\n`);

        await waitUntil({
          message: 'the note\'s embed of the attachment is indexed',
          predicate: () => app.metadataCache.getBacklinksForFile(attachment).keys().length === 1,
          timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
        });

        await app.fileManager.trashFile(note);

        // The effect first, then the drain: `flushQueue` covers only what is already enqueued.
        await waitUntil({
          message: 'the attachment folder the deletion emptied is deleted',
          predicate: () => app.vault.getFolderByPath(ATTACHMENT_FOLDER) === null,
          timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
        });
        await flushQueue();

        return {
          doesAttachmentFolderExist: await app.vault.adapter.exists(ATTACHMENT_FOLDER),
          doesNoteFolderExist: await app.vault.adapter.exists(NOTE_FOLDER)
        };
      } finally {
        app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
        // Saved at once, so a reload of `app.json` before the debounced save cannot hand the next suite this case's folder.
        await app.vault.saveConfig();
        /*
         * Through the adapter: a fixture teardown must not travel back through the very delete path this
         * plugin patches, which would make the cleanup part of what is under test.
         */
        if (await app.vault.adapter.exists(root)) {
          await app.vault.adapter.rmdir(root, true);
        }
      }
    },
    // Spelled out field by field: an interface is not assignable to the transport's `Record<string, unknown>`.
    input: {
      pluginId: input.pluginId,
      root: input.root,
      shouldDeleteEmptyNoteFolders: input.shouldDeleteEmptyNoteFolders,
      sourcePluginId: input.sourcePluginId
    }
  });
}

describe('Deleting the last note in its folder', () => {
  it('leaves the note\'s folder and deletes only the emptied attachment folder', async () => {
    const result = await runDeleteNote({
      pluginId: PLUGIN_ID,
      root: 'rdh-empty-note-folder-kept',
      shouldDeleteEmptyNoteFolders: false,
      sourcePluginId: SOURCE_PLUGIN_ID
    });

    expect(result.doesAttachmentFolderExist).toBe(false);
    expect(result.doesNoteFolderExist).toBe(true);
  });

  it('deletes the note\'s folder too when shouldDeleteEmptyNoteFolders is on', async () => {
    const result = await runDeleteNote({
      pluginId: PLUGIN_ID,
      root: 'rdh-empty-note-folder-deleted',
      shouldDeleteEmptyNoteFolders: true,
      sourcePluginId: SOURCE_PLUGIN_ID
    });

    expect(result.doesAttachmentFolderExist).toBe(false);
    expect(result.doesNoteFolderExist).toBe(false);
  });
});
