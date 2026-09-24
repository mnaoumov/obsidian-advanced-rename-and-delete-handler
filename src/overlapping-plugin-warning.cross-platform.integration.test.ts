import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * The other half of this plugin's overlap handling, driven end to end: with a plugin installed that still
 * ships its own copy of the `delete-empty-folders` command, this one says so and BOTH keep running.
 *
 * That is the whole distinction from `conflicting-plugin-block.cross-platform.integration.test.ts`. Two
 * rename/delete handlers corrupt a vault, so that overlap is declared at `Block` severity and holds this
 * plugin's feature surface shut; a duplicated command merely doubles a palette entry, so blocking would cost
 * the user more than the overlap does. The observable difference is that the feature surface is still there
 * afterwards — both plugins run, and this one says so.
 *
 * The stub is installed at a version ABOVE the rename/delete block's ceiling on purpose — `<4.0.0` blocks
 * and `>=4.0.0 <4.1.0` warns, for the same plugin id, so a lower version would shut the surface and the
 * warning would never be reached. It stays below `4.1.0`, the release that dropped the command.
 *
 * Cross-platform: an overlapping plugin is just as installable on a phone, and the manifest declares
 * `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const OVERLAPPING_PLUGIN_ID = 'consistent-attachments-and-links';
const OVERLAPPING_PLUGIN_NAME = 'Consistent Attachments and Links';
const OVERLAPPING_PLUGIN_VERSION = '4.0.1';

interface OverlapWarningResult {
  readonly enableError: null | string;
  readonly isLoadedAfter: boolean;
  readonly isLoadedBefore: boolean;
  readonly isOverlapEnabled: boolean;
  readonly isOverlapRegistered: boolean;
  readonly isWarningNoticeShown: boolean;
}

describe('A plugin that still ships its own Delete empty folders command', () => {
  it('is announced as an overlap, with both plugins left running', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        overlappingPluginId,
        overlappingPluginName,
        overlappingPluginVersion,
        pluginId
      }): Promise<OverlapWarningResult> {
        const pluginFolder = `${app.vault.configDir}/plugins/${overlappingPluginId}`;
        const adapter = app.vault.adapter;

        const isLoadedBefore = Object.hasOwn(app.plugins.plugins, pluginId);
        let enableError: null | string = null;

        try {
          await adapter.mkdir(pluginFolder);
          await adapter.write(
            `${pluginFolder}/manifest.json`,
            JSON.stringify({
              author: 'test',
              description: 'A stub standing in for a version that still deletes empty folders.',
              id: overlappingPluginId,
              minAppVersion: '0.0.1',
              name: overlappingPluginName,
              version: overlappingPluginVersion
            })
          );
          // A plugin Obsidian can actually load, which does nothing.
          await adapter.write(
            `${pluginFolder}/main.js`,
            'module.exports = class extends require("obsidian").Plugin {};'
          );

          await app.plugins.loadManifests();
          const isOverlapRegistered = Object.hasOwn(app.plugins.manifests, overlappingPluginId);

          try {
            await app.plugins.enablePluginAndSave(overlappingPluginId);
          } catch (error) {
            enableError = error instanceof Error ? error.message : String(error);
          }

          // Reload this plugin so its load-time overlap check runs with the stub present.
          await app.plugins.disablePlugin(pluginId);
          await app.plugins.enablePlugin(pluginId);

          let isWarningNoticeShown = false;
          const noticeDeadline = Date.now() + 5000;
          while (Date.now() < noticeDeadline && !isWarningNoticeShown) {
            isWarningNoticeShown = document.body.textContent.includes('overlap, and both are running');
            if (!isWarningNoticeShown) {
              await sleep(200);
            }
          }

          return {
            enableError,
            // The point of the whole test: a warning leaves the plugin running, where the rename/delete
            // Block would have held its feature surface shut.
            isLoadedAfter: Object.hasOwn(app.plugins.plugins, pluginId),
            isLoadedBefore,
            isOverlapEnabled: app.plugins.enabledPlugins.has(overlappingPluginId),
            isOverlapRegistered,
            isWarningNoticeShown
          };
        } finally {
          try {
            await app.plugins.disablePluginAndSave(overlappingPluginId);
          } catch {
            // Already off, or never on.
          }
          await adapter.rmdir(pluginFolder, true);
          await app.plugins.loadManifests();
          await app.plugins.enablePlugin(pluginId);
        }
      },
      input: {
        overlappingPluginId: OVERLAPPING_PLUGIN_ID,
        overlappingPluginName: OVERLAPPING_PLUGIN_NAME,
        overlappingPluginVersion: OVERLAPPING_PLUGIN_VERSION,
        pluginId: PLUGIN_ID
      }
    });

    expect(result.enableError).toBeNull();
    expect(result.isOverlapRegistered).toBe(true);
    expect(result.isOverlapEnabled).toBe(true);
    expect(result.isLoadedBefore).toBe(true);
    expect(result.isWarningNoticeShown).toBe(true);
    expect(result.isLoadedAfter).toBe(true);
  });
});
