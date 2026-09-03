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

/**
 * The subset of what `getSettings` hands back that this suite's expectations depend on.
 *
 * Read before proposing anything, because every assertion below is about which rows the dialog shows — and a
 * row appears only where the proposal DIFFERS from what the plugin already holds. Inheriting either value
 * from an earlier suite silently changes the answer.
 */
interface CurrentSettingsLike {
  readonly notePriorities: readonly string[];
  readonly shouldHandleDeletions: boolean;
  readonly shouldRenameAttachmentFiles: boolean;
}

interface MigrateSettingsParamsLike {
  readonly proposedSettings: ProposedSettingsLike;
  readonly sourcePluginId: string;
}

interface MigrateSettingsResultLike {
  readonly isApplied: boolean;
}

interface MigrationApiLike {
  getSettings(): CurrentSettingsLike;
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

/*
 * This plugin's settings outlive each test file — one run drives every suite against one Obsidian instance —
 * so what this suite stages must not become the starting point of whichever file the sequencer runs next.
 * This suite writes settings for real — the first case approves them — so it is one of the ones that has to
 * hand them back. See `settings-snapshot.integration-helper.ts`.
 */
let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

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

        /*
         * The two rows this case expects exist only because both values differ from what the plugin holds.
         * Said out loud so that a suite which left them behind is named here, instead of being reported as a
         * dialog that never opened.
         */
        const currentSettings = api.getSettings();
        if (currentSettings.shouldHandleDeletions || currentSettings.notePriorities.length > 0) {
          throw new Error(
            `the vault did not arrive at this suite's defaults: shouldHandleDeletions=${String(currentSettings.shouldHandleDeletions)}, notePriorities=[${currentSettings.notePriorities.join(', ')}]`
          );
        }

        const migrationPromise = api.migrateSettings({
          proposedSettings: {
            notePriorities: ['.md'],
            shouldHandleDeletions: true
          },
          sourcePluginId
        });

        let isSettled = false;
        /*
         * A proposal that changes nothing resolves with no dialog at all. That cannot happen here — the guard
         * above rules it out — but waiting on the modal alone would turn any future regression into a bare
         * 20s timeout naming nothing, so the wait settles on either outcome and the throw below says which.
         *
         * Never rejects — the `catch` absorbs it — so awaiting it keeps it from floating, while the
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
          message: 'the comparison dialog opens',
          predicate: () => isSettled || document.querySelector('.modal-container') !== null,
          timeoutInMilliseconds: 20_000
        });

        const modalEl = document.querySelector('.modal-container');
        if (!modalEl) {
          await settlementPromise;
          throw new Error('the proposal changed nothing, so no comparison dialog opened');
        }

        const title = modalEl.querySelector('.modal-title')?.textContent ?? '';
        const rowNames = [...modalEl.querySelectorAll('.setting-item-name')].map((nameEl) => nameEl.textContent);

        const okButton = [...modalEl.querySelectorAll('button')].find((button) => button.textContent === 'OK');
        if (!okButton) {
          throw new Error('the comparison dialog has no OK button');
        }

        okButton.click();

        await settlementPromise;
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

        // The one row this case cancels exists only because the proposed value differs from the held one.
        const currentSettings = api.getSettings();
        if (currentSettings.shouldRenameAttachmentFiles) {
          throw new Error('the vault did not arrive at this suite\'s defaults: shouldRenameAttachmentFiles is already on');
        }

        const migrationPromise = api.migrateSettings({
          proposedSettings: { shouldRenameAttachmentFiles: true },
          sourcePluginId
        });

        let isSettled = false;
        // Settles on either outcome, for the reason the first case states.
        const settlementPromise = migrationPromise
          .then(() => {
            isSettled = true;
          })
          .catch(() => {
            isSettled = true;
          });

        await waitUntil({
          message: 'the comparison dialog opens',
          predicate: () => isSettled || document.querySelector('.modal-container') !== null,
          timeoutInMilliseconds: 20_000
        });

        const modalEl = document.querySelector('.modal-container');
        if (!modalEl) {
          await settlementPromise;
          throw new Error('the proposal changed nothing, so no comparison dialog opened');
        }

        const cancelButton = [...modalEl.querySelectorAll('button')].find((button) => button.textContent === 'Cancel');
        if (!cancelButton) {
          throw new Error('the comparison dialog has no Cancel button');
        }

        cancelButton.click();

        await settlementPromise;
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
