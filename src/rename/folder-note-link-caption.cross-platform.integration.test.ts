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
 * Turning a note into a folder note keeps the folder's name as a backlink's caption: renaming
 * `alpha/bravo/charlie.md` to `alpha/bravo/charlie/!.md` under a `folder-notes` setup that names every folder
 * note `!` must leave `[charlie](alpha/bravo/charlie/!.md)`, never `[!](...)`.
 *
 * `shouldUpdateFileNameAliases` refreshes a caption equal to the old base name to the new one, and the new
 * base name of a folder note is `!`. `@mnaoumov/obsidian-lib` 6.2.1 answers the folder's name instead, through
 * `getFolderNoteFolder`, which reads the installed `folder-notes` plugin's settings. This suite stands in for
 * that plugin with a record carrying only its settings, the shape the library reads, and removes it after.
 *
 * Cross-platform: a folder note is made on a phone as readily as on a desktop.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface FolderNoteCaptionResult {
  readonly referencingNoteContentAfter: string;
  readonly referencingNoteContentBefore: string;
}

interface MigratableSettingsLike {
  readonly shouldHandleRenames?: boolean;
  readonly shouldUpdateFileNameAliases?: boolean;
}

interface MigrateSettingsParamsLike {
  readonly proposedSettings: MigratableSettingsLike;
  readonly sourcePluginId: string;
}

interface MigrateSettingsResultLike {
  readonly isApplied: boolean;
}

interface MigrationApiLike {
  readonly migrateSettings: (params: MigrateSettingsParamsLike) => Promise<MigrateSettingsResultLike>;
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

describe('Turning a note into a folder note', () => {
  it('keeps the folder\'s name as a backlink\'s caption', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<FolderNoteCaptionResult> {
        const FOLDER = 'rdh-folder-note-caption';
        const OLD_TARGET = `${FOLDER}/alpha/bravo/charlie.md`;
        const NEW_FOLDER = `${FOLDER}/alpha/bravo/charlie`;
        const NEW_TARGET = `${NEW_FOLDER}/!.md`;
        const REFERENCING_NOTE = `${FOLDER}/referencing-note.md`;
        const FOLDER_NOTES_PLUGIN_ID = 'folder-notes';
        /*
         * Under the transport's ~30s per-closure cap, not at it. `applySettings` runs once and each of the
         * three waits once, so four charges share the allowance; what is waited on lands in well under a
         * second.
         */
        const WAIT_TIMEOUT_IN_MILLISECONDS = 6000;

        const apiRecord = (window as PluginApiRegistryHostLike).__obsidianLib?.pluginApiRegistry?.value?.records?.[pluginId]
          ?.find((candidate) => !candidate.isRevoked);
        if (!apiRecord) {
          throw new Error(`${pluginId} has published no API`);
        }

        const api = apiRecord.api;

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
          // Never rejects, so awaiting it keeps it from floating; the migration's own rejection surfaces below.
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

        if (app.plugins.getPlugin(FOLDER_NOTES_PLUGIN_ID)) {
          throw new Error(`a real ${FOLDER_NOTES_PLUGIN_ID} plugin is loaded, which this suite would shadow`);
        }

        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');
        const originalNewLinkFormat = app.vault.getConfig('newLinkFormat');
        const originalUseMarkdownLinks = app.vault.getConfig('useMarkdownLinks');

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          // Saved at once, so a config reload cannot bring `app.json`'s older values back mid-case.
          app.vault.setConfig('alwaysUpdateLinks', true);
          app.vault.setConfig('newLinkFormat', 'absolute');
          app.vault.setConfig('useMarkdownLinks', true);
          await app.vault.saveConfig();

          // Only its settings, the one part of that plugin the library reads.
          Object.assign(app.plugins.plugins, {
            [FOLDER_NOTES_PLUGIN_ID]: {
              settings: {
                folderNoteName: '!',
                storageLocation: 'insideFolder'
              }
            }
          });

          await applySettings({
            shouldHandleRenames: true,
            shouldUpdateFileNameAliases: true
          });

          await app.vault.createFolder(NEW_FOLDER);
          const target = await app.vault.create(OLD_TARGET, '# Target\n');
          const referencingNote = await app.vault.create(REFERENCING_NOTE, `[charlie](${OLD_TARGET})\n`);

          await waitUntil({
            message: 'backlink to the target indexed by the metadata cache',
            predicate: () => app.metadataCache.getBacklinksForFile(target).keys().length > 0,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const referencingNoteContentBefore = await app.vault.read(referencingNote);

          await app.fileManager.renameFile(target, NEW_TARGET);
          await waitUntil({
            message: 'the backlink is rewritten after the rename',
            predicate: async () => (await app.vault.read(referencingNote)) !== referencingNoteContentBefore,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });
          // After the effect, so the drain covers the rest of the same operation.
          await flushQueue();

          return {
            referencingNoteContentAfter: await app.vault.read(referencingNote),
            referencingNoteContentBefore
          };
        } finally {
          // The stand-in is removed before the folder, so no other suite ever sees a `folder-notes` setup.
          Reflect.deleteProperty(app.plugins.plugins, FOLDER_NOTES_PLUGIN_ID);
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
          app.vault.setConfig('newLinkFormat', originalNewLinkFormat);
          app.vault.setConfig('useMarkdownLinks', originalUseMarkdownLinks);
          await app.vault.saveConfig();
          // Through the adapter, so the teardown does not travel back through the delete path this plugin patches.
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

    expect(result.referencingNoteContentBefore).toBe('[charlie](rdh-folder-note-caption/alpha/bravo/charlie.md)\n');
    expect(result.referencingNoteContentAfter).toBe('[charlie](rdh-folder-note-caption/alpha/bravo/charlie/!.md)\n');
  });
});
