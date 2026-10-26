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
 * Issue #6: with Obsidian Sync on, `data.json` was reported rewritten forever, alternating between two devices,
 * with the same bytes every time. Sync tells the receiving device's plugin through `onExternalSettingsChange`, so a
 * plugin that answered that call with a write would send the file straight back, and the other device would do
 * the same.
 *
 * The suite stands in for Sync the way Obsidian sees it: the file is written under the plugin, Obsidian's own
 * `raw` watcher notices it, and its debounced config-file check calls `onExternalSettingsChange`. Every
 * `saveData` the plugin makes from then on is recorded with its stack, so a failure names the writer.
 *
 * It uses the reporter's `data.json` verbatim. The plugin serializes those settings to exactly the 587 bytes the
 * report quotes, so this is the file the loop was seen on, not an approximation of it.
 *
 * Cross-platform: Sync runs on phones too.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';

const REPORTED_DATA = {
  emptyFolderBehavior: 'DeleteWithEmptyParents',
  excludePaths: [String.raw`/consistency-report\.md$/`],
  includePaths: [],
  notePriorities: [],
  rescueAttachmentUsedByMultipleNotesMode: 'prompt',
  shouldDeleteConflictingAttachments: false,
  shouldDeleteEmptyNoteFolders: true,
  shouldHandleDeletions: false,
  shouldHandleRenames: true,
  shouldRenameAttachmentFiles: false,
  shouldRenameAttachmentFolder: false,
  shouldRescueSharedAttachments: false,
  shouldUpdateFileNameAliases: true,
  treatAsAttachmentExtensions: ['.excalidraw.md']
};

/*
 * Under the transport's ~30s per-closure cap, not at it. Charged twice, once per external write (the staged file
 * and the restore), plus the settle time below; Obsidian's watcher and its 50 ms debounce answer in well under a
 * second.
 */
const WAIT_TIMEOUT_IN_MILLISECONDS = 5000;

/*
 * How long a write answering the reload is given to appear. Obsidian awaits the handler, so a write the handler
 * makes has landed by the time the reload is seen; this covers one the handler only schedules.
 */
const SETTLE_TIME_IN_MILLISECONDS = 1000;

interface ExternalChangeProbeResult {
  readonly contentAfter: string;
  readonly contentBefore: string;
  readonly saveDataStacks: readonly string[];
}

let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('An external change to data.json', () => {
  it('is read without writing the file back', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: { sleep, waitUntil },
        pluginId,
        reportedData,
        settleTimeInMilliseconds,
        timeoutInMilliseconds
      }): Promise<ExternalChangeProbeResult> {
        const dataPath = `${app.vault.configDir}/plugins/${pluginId}/data.json`;
        const adapter = app.vault.adapter;

        const plugin = app.plugins.plugins[pluginId];
        if (!plugin) {
          throw new Error(`${pluginId} is not loaded`);
        }

        const originalOnExternalSettingsChange = plugin.onExternalSettingsChange?.bind(plugin);
        if (!originalOnExternalSettingsChange) {
          throw new Error(`${pluginId} does not handle external settings changes`);
        }

        const originalSaveData = plugin.saveData.bind(plugin);
        const saveDataStacks: string[] = [];
        let reloadCount = 0;

        // Installed before the first await, so no read of `plugin` they rely on can go stale.
        plugin.onExternalSettingsChange = async (): Promise<void> => {
          await originalOnExternalSettingsChange();
          reloadCount++;
        };
        plugin.saveData = async (data: unknown): Promise<void> => {
          saveDataStacks.push(new Error('saveData').stack ?? '');
          await originalSaveData(data);
        };

        /*
         * Waits for Obsidian's own reload rather than calling the handler, so the reload this write causes cannot
         * fire after the closure returns, in the middle of the next suite.
         */
        async function writeExternally(content: string): Promise<void> {
          const expectedReloadCount = reloadCount + 1;
          await adapter.write(dataPath, content);
          await waitUntil({
            message: 'Obsidian reports the external change to the plugin',
            predicate: () => reloadCount >= expectedReloadCount,
            timeoutInMilliseconds
          });
        }

        const contentBefore = JSON.stringify(reportedData, null, 2);
        let originalContent: null | string = null;

        try {
          originalContent = await adapter.read(dataPath);
          await writeExternally(contentBefore);
          await sleep({ milliseconds: settleTimeInMilliseconds });

          return {
            contentAfter: await adapter.read(dataPath),
            contentBefore,
            saveDataStacks: [...saveDataStacks]
          };
        } finally {
          if (originalContent !== null) {
            await writeExternally(originalContent);
          }

          const restoredPlugin = app.plugins.plugins[pluginId];
          if (restoredPlugin) {
            restoredPlugin.saveData = originalSaveData;
            restoredPlugin.onExternalSettingsChange = originalOnExternalSettingsChange;
          }
        }
      },
      input: {
        pluginId: PLUGIN_ID,
        reportedData: REPORTED_DATA,
        settleTimeInMilliseconds: SETTLE_TIME_IN_MILLISECONDS,
        timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
      }
    });

    expect(result.saveDataStacks).toEqual([]);
    expect(result.contentAfter).toBe(result.contentBefore);
  });
});
