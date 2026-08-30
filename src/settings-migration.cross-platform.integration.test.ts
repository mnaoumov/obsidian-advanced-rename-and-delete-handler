import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * The public API, driven the way a consumer plugin drives it: a proposal goes in, the comparison dialog
 * comes up, and what the user does with it decides whether anything is written.
 *
 * Driven through the plugin's own `api` field — the fallback path a consumer takes when it cannot depend on
 * a library version new enough to have the registry. `lib.watchPluginApi` is reachable now that
 * `scripts/vitest-config.ts` seeds the `obsidian-dev-utils` integration-test harness plugin, but this test
 * deliberately stays on the fallback field: it is the only end-to-end coverage the fallback has, and the
 * registry path is covered by unit tests.
 *
 * Cross-platform: nothing here is desktop-only. A consumer proposes its settings on a phone too, and the
 * dialog is the same modal.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface MigrateSettingsParamsLike {
  readonly proposedSettings: ProposedSettingsLike;
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

interface ProposedSettingsLike {
  readonly notePriorities?: readonly string[];
  readonly shouldHandleDeletions?: boolean;
  readonly shouldRenameAttachmentFiles?: boolean;
}

interface SettingsMigrationProbeResult {
  readonly isApplied: boolean;
  readonly rowNames: readonly string[];
  readonly savedNotePriorities: unknown;
  readonly savedShouldHandleDeletions: unknown;
  readonly savedShouldRenameAttachmentFiles: unknown;
  readonly title: string;
}

describe('A consumer plugin proposing its rename/delete settings', () => {
  it('is offered for review, and writes what the user approves', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: { waitUntil },
        pluginId,
        sourcePluginId
      }): Promise<SettingsMigrationProbeResult> {
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

        const migrationPromise = api.migrateSettings({
          proposedSettings: {
            notePriorities: ['.md'],
            shouldHandleDeletions: true
          },
          sourcePluginId
        });

        await waitUntil({
          message: 'the comparison dialog opens',
          predicate: () => document.querySelector('.modal-container') !== null,
          timeoutInMilliseconds: 20_000
        });

        const modalEl = document.querySelector('.modal-container');
        if (!modalEl) {
          throw new Error('the comparison dialog did not open');
        }

        const title = modalEl.querySelector('.modal-title')?.textContent ?? '';
        const rowNames = [...modalEl.querySelectorAll('.setting-item-name')].map((nameEl) => nameEl.textContent);

        const okButton = [...modalEl.querySelectorAll('button')].find((button) => button.textContent === 'OK');
        if (!okButton) {
          throw new Error('the comparison dialog has no OK button');
        }

        okButton.click();

        const migrateSettingsResult = await migrationPromise;
        function readSavedValue(record: unknown, key: string): unknown {
          if (typeof record !== 'object' || record === null) {
            return undefined;
          }

          return Object.entries(record).find(([entryKey]) => entryKey === key)?.[1];
        }

        const savedRecord = await plugin.loadData();

        return {
          isApplied: migrateSettingsResult.isApplied,
          rowNames,
          savedNotePriorities: readSavedValue(savedRecord, 'notePriorities'),
          savedShouldHandleDeletions: readSavedValue(savedRecord, 'shouldHandleDeletions'),
          savedShouldRenameAttachmentFiles: readSavedValue(savedRecord, 'shouldRenameAttachmentFiles'),
          title
        };
      },
      input: {
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    // The dialog names the plugin that asked, so the user knows whose settings they are being offered.
    expect(result.title).toBe(`Settings proposed by ${SOURCE_PLUGIN_ID}`);
    // One row per setting that would actually change, in the settings tab's own order.
    expect(result.rowNames).toEqual([
      'Should handle deletions',
      'Note priorities'
    ]);
    expect(result.isApplied).toBe(true);
    // The point of the whole exercise: the approved values reached this plugin's own saved settings.
    expect(result.savedShouldHandleDeletions).toBe(true);
    expect(result.savedNotePriorities).toEqual(['.md']);
  });

  it('writes nothing when the user cancels', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: { waitUntil },
        pluginId,
        sourcePluginId
      }): Promise<SettingsMigrationProbeResult> {
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

        const migrationPromise = api.migrateSettings({
          proposedSettings: { shouldRenameAttachmentFiles: true },
          sourcePluginId
        });

        await waitUntil({
          message: 'the comparison dialog opens',
          predicate: () => document.querySelector('.modal-container') !== null,
          timeoutInMilliseconds: 20_000
        });

        const modalEl = document.querySelector('.modal-container');
        if (!modalEl) {
          throw new Error('the comparison dialog did not open');
        }

        const cancelButton = [...modalEl.querySelectorAll('button')].find((button) => button.textContent === 'Cancel');
        if (!cancelButton) {
          throw new Error('the comparison dialog has no Cancel button');
        }

        cancelButton.click();

        const migrateSettingsResult = await migrationPromise;
        function readSavedValue(record: unknown, key: string): unknown {
          if (typeof record !== 'object' || record === null) {
            return undefined;
          }

          return Object.entries(record).find(([entryKey]) => entryKey === key)?.[1];
        }

        const savedRecord = await plugin.loadData();

        return {
          isApplied: migrateSettingsResult.isApplied,
          rowNames: [],
          savedNotePriorities: readSavedValue(savedRecord, 'notePriorities'),
          savedShouldHandleDeletions: readSavedValue(savedRecord, 'shouldHandleDeletions'),
          savedShouldRenameAttachmentFiles: readSavedValue(savedRecord, 'shouldRenameAttachmentFiles'),
          title: ''
        };
      },
      input: {
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    expect(result.isApplied).toBe(false);
    // Cancel is not "later" — it is "no", and nothing reaches the saved settings.
    expect(result.savedShouldRenameAttachmentFiles).not.toBe(true);
  });
});
