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
 * Issue #8: a rename that updated links always ended with an `Updated N links in M files.` notice, so a batch of
 * renames from a script filled the screen with them. `shouldShowLinkUpdateNotice` turns that one notice off.
 *
 * The setting is not in the published API, because no consumer ever owned it, so `migrateSettings` cannot write it
 * and the settings snapshot cannot restore it. It goes in through `configureCommunityPlugin`, the path the demo
 * vault's buttons use, and the closure puts back what `data.json` held.
 *
 * Proving a notice did NOT appear needs the drain to be over. The notice is shown by an operation the rename
 * handler enqueues from its own `finally`, so one `flushQueue` that starts while the handler is still running
 * drains to a point ahead of it. The second one starts once the handler is done and its operation is queued.
 *
 * Cross-platform: a script-driven batch rename runs on a phone as well.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface LinkUpdateNoticeResult {
  readonly newNoticeTexts: readonly string[];
  readonly referencingNoteContentAfter: string;
}

interface MigratableSettingsLike {
  readonly shouldHandleRenames?: boolean;
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

let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('The notice after a rename updates links', () => {
  it('is not shown when shouldShowLinkUpdateNotice is off', async () => {
    const result = await renameWithNoticeSetting(false);

    expect(result.referencingNoteContentAfter).toContain('renamed');
    expect(result.newNoticeTexts).toEqual([]);
  });

  it('is shown when shouldShowLinkUpdateNotice is on', async () => {
    const result = await renameWithNoticeSetting(true);

    expect(result.referencingNoteContentAfter).toContain('renamed');
    expect(result.newNoticeTexts).toEqual([expect.stringContaining('Updated 1 link in 1 file.')]);
  });
});

async function renameWithNoticeSetting(shouldShowLinkUpdateNotice: boolean): Promise<LinkUpdateNoticeResult> {
  return await evalInObsidian({
    async callback({
      app,
      lib: {
        configureCommunityPlugin,
        flushQueue,
        waitUntil
      },
      pluginId,
      shouldShowLinkUpdateNotice: shouldShow,
      sourcePluginId
    }): Promise<LinkUpdateNoticeResult> {
      const FOLDER = `rdh-link-update-notice-${String(shouldShow)}`;
      const TARGET = `${FOLDER}/target.md`;
      const RENAMED_TARGET = `${FOLDER}/renamed.md`;
      const REFERENCING_NOTE = `${FOLDER}/referencing-note.md`;
      /*
       * Under the transport's ~30s per-closure cap, not at it. Charged three times: the settings dialog, the
       * backlink index and the rewrite. Each lands in well under a second.
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

      const dataPath = `${app.vault.configDir}/plugins/${pluginId}/data.json`;
      const originalData = await app.vault.adapter.exists(dataPath)
        ? JSON.parse(await app.vault.adapter.read(dataPath)) as Record<string, unknown>
        : {};
      const originalShouldShowLinkUpdateNotice = originalData['shouldShowLinkUpdateNotice'] ?? true;
      const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');

      try {
        // Obsidian otherwise asks for confirmation through a modal, which would stall a headless run.
        app.vault.setConfig('alwaysUpdateLinks', true);
        await app.vault.saveConfig();

        await applySettings({ shouldHandleRenames: true });
        await configureCommunityPlugin({
          app,
          pluginId,
          settings: { shouldShowLinkUpdateNotice: shouldShow }
        });

        await app.vault.createFolder(FOLDER);
        const target = await app.vault.create(TARGET, '# Target\n');
        const referencingNote = await app.vault.create(REFERENCING_NOTE, `[[${TARGET}]]\n`);

        await waitUntil({
          message: 'backlink to the target indexed by the metadata cache',
          predicate: () => app.metadataCache.getBacklinksForFile(target).keys().length > 0,
          timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
        });

        const noticesBefore = new Set(document.querySelectorAll('.notice'));
        const referencingNoteContentBefore = await app.vault.read(referencingNote);

        await app.fileManager.renameFile(target, RENAMED_TARGET);
        await waitUntil({
          message: 'the backlink is rewritten after the rename',
          predicate: async () => (await app.vault.read(referencingNote)) !== referencingNoteContentBefore,
          timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
        });
        // Twice, for the reason in the file header: the notice is enqueued by the handler's own `finally`.
        await flushQueue();
        await flushQueue();

        return {
          newNoticeTexts: [...document.querySelectorAll('.notice')]
            .filter((noticeEl) => !noticesBefore.has(noticeEl))
            .map((noticeEl) => noticeEl.textContent)
            .filter((text) => text.includes('Updated ')),
          referencingNoteContentAfter: await app.vault.read(referencingNote)
        };
      } finally {
        await configureCommunityPlugin({
          app,
          pluginId,
          settings: { shouldShowLinkUpdateNotice: originalShouldShowLinkUpdateNotice }
        });
        app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
        await app.vault.saveConfig();
        // Through the adapter, so the teardown does not travel back through the delete path this plugin patches.
        if (await app.vault.adapter.exists(FOLDER)) {
          await app.vault.adapter.rmdir(FOLDER, true);
        }
      }
    },
    input: {
      pluginId: PLUGIN_ID,
      shouldShowLinkUpdateNotice,
      sourcePluginId: SOURCE_PLUGIN_ID
    }
  });
}
