import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * Renaming a note refreshes the display text of a link whose alias equals the note's OLD base name:
 * `[[folder/2|2]]` pointing at `folder/2.md` must become a link to `222` once the target is renamed to
 * `folder/222.md`, never a stale `|2`.
 *
 * See https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/20.
 *
 * `shouldUpdateFileNameAliases` is what asks for the refresh, and this plugin owns that setting now.
 *
 * Ported from `obsidian-custom-attachment-location`, which deleted the suite when it stopped registering a
 * rename/delete handler. Rewritten rather than copied: the original assigned to a settings object it found by
 * walking the plugin's component tree, while here settings go in through the plugin's own `migrateSettings`
 * API, its only public write path. Each case repeats its own settings helper because an `evalInObsidian`
 * callback is serialized and reaches nothing outside itself.
 *
 * Cross-platform: an alias goes stale on a phone as readily as on a desktop, and the manifest declares
 * `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

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
  migrateSettings(params: MigrateSettingsParamsLike): Promise<MigrateSettingsResultLike>;
}

interface PluginWithApiLike {
  readonly api: MigrationApiLike;
}

interface RenameAliasResult {
  readonly referencingNoteContentAfter: string;
  readonly referencingNoteContentBefore: string;
  readonly resolvedLinkPath: null | string;
}

describe('Renaming a note whose backlink aliases its old base name', () => {
  it('refreshes the alias to the new base name', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<RenameAliasResult> {
        const FOLDER = 'rdh-alias-refresh';
        const OLD_TARGET = `${FOLDER}/2.md`;
        const NEW_TARGET = `${FOLDER}/222.md`;
        const REFERENCING_NOTE = `${FOLDER}/referencing-note.md`;
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

        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          // Obsidian otherwise asks for confirmation through a modal, which would stall a headless run.
          app.vault.setConfig('alwaysUpdateLinks', true);

          // Both are the plugin's own defaults, stated so the scenario cannot silently drift with them.
          await applySettings({
            shouldHandleRenames: true,
            shouldUpdateFileNameAliases: true
          });

          await app.vault.createFolder(FOLDER);
          const target = await app.vault.create(OLD_TARGET, '# Target\n');
          const referencingNote = await app.vault.create(REFERENCING_NOTE, `[[${OLD_TARGET}|2]]\n`);

          await waitUntil({
            message: 'backlink to the target indexed by the metadata cache',
            predicate: () => app.metadataCache.getBacklinksForFile(target).keys().length > 0,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const referencingNoteContentBefore = await app.vault.read(referencingNote);

          await app.fileManager.renameFile(target, NEW_TARGET);
          // The handler rewrites the backlinks on its own queue, which this drains.
          await flushQueue();
          await waitUntil({
            message: 'the backlink is rewritten after the rename',
            predicate: async () => (await app.vault.read(referencingNote)) !== referencingNoteContentBefore,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const referencingNoteContentAfter = await app.vault.read(referencingNote);

          /*
           * Resolved rather than matched as text: Obsidian rewrites using the vault's configured link
           * format, so a folder-qualified link legitimately comes back as a shortest-path one. A text
           * assertion would fail on a correct rewrite.
           */
          const link = app.metadataCache.getFileCache(referencingNote)?.links?.[0];
          const resolvedLinkPath = link
            ? app.metadataCache.getFirstLinkpathDest(link.link, REFERENCING_NOTE)?.path ?? null
            : null;

          return {
            referencingNoteContentAfter,
            referencingNoteContentBefore,
            resolvedLinkPath
          };
        } finally {
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
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

    expect(result.referencingNoteContentBefore).toContain('|2]]');
    expect(result.resolvedLinkPath).toBe('rdh-alias-refresh/222.md');

    /*
     * The alias must be refreshed to the NEW base name, never left stale as `|2`. Real Obsidian normalizes
     * the refreshed link to its shortest unique form `[[222]]` — an alias equal to the base name is
     * redundant and dropped — so the form-independent effect is that the link names `222` and carries no
     * `|2` display text. The defect this pins left `[[222|2]]`, which the `not.toMatch` catches.
     */
    expect(result.referencingNoteContentAfter).toContain('222');
    expect(result.referencingNoteContentAfter).not.toMatch(/\|2\]\]/);
  });
});
