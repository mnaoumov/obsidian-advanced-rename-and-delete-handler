import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * The behavior that distinguishes this plugin, driven end to end: with a plugin installed that still
 * owns its own rename/delete handler, this one must refuse to run rather than compete for control.
 *
 * A stub is installed under a conflicting plugin's id at a version below the minimum this plugin
 * accepts, and this plugin is then reloaded. The observable effect is that it disables itself — which is
 * what stops two handlers acting on one rename.
 *
 * The intermediate state is reported rather than awaited, so a setup that did not take (the stub never
 * registering, say) fails as a readable expectation instead of an opaque timeout.
 *
 * Cross-platform: a conflicting plugin is just as installable on a phone, and the manifest declares
 * `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-delete-handler';
const CONFLICTING_PLUGIN_ID = 'obsidian-custom-attachment-location';
const CONFLICTING_PLUGIN_VERSION = '11.10.0';

interface ConflictRefusalResult {
  readonly enableError: null | string;
  readonly isConflictEnabled: boolean;
  readonly isConflictRegistered: boolean;
  readonly isLoadedAfter: boolean;
  readonly isLoadedBefore: boolean;
  readonly isRefusalNoticeShown: boolean;
  readonly isStillEnabledInConfig: boolean;
  readonly isStillInstalled: boolean;
}

describe('A plugin that still owns its own rename/delete handler', () => {
  it('makes this plugin disable itself instead of competing', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        conflictingPluginId,
        conflictingPluginVersion,
        pluginId
      }): Promise<ConflictRefusalResult> {
        const pluginFolder = `${app.vault.configDir}/plugins/${conflictingPluginId}`;
        const adapter = app.vault.adapter;

        const isLoadedBefore = Object.hasOwn(app.plugins.plugins, pluginId);
        let enableError: null | string = null;

        try {
          await adapter.mkdir(pluginFolder);
          await adapter.write(
            `${pluginFolder}/manifest.json`,
            JSON.stringify({
              author: 'test',
              description: 'A stub standing in for a version that still owns its own handler.',
              id: conflictingPluginId,
              minAppVersion: '0.0.1',
              name: 'Custom Attachment Location',
              version: conflictingPluginVersion
            })
          );
          // A plugin Obsidian can actually load, which does nothing.
          await adapter.write(
            `${pluginFolder}/main.js`,
            'module.exports = class extends require("obsidian").Plugin {};'
          );

          await app.plugins.loadManifests();
          const isConflictRegistered = Object.hasOwn(app.plugins.manifests, conflictingPluginId);

          try {
            await app.plugins.enablePluginAndSave(conflictingPluginId);
          } catch (error) {
            enableError = error instanceof Error ? error.message : String(error);
          }

          // Reload this plugin so its load-time conflict check runs with the stub present.
          await app.plugins.disablePlugin(pluginId);
          await app.plugins.enablePlugin(pluginId);

          // Did the refusal path run at all? Its notice is the only externally visible evidence.
          let isRefusalNoticeShown = false;
          const noticeDeadline = Date.now() + 5000;
          while (Date.now() < noticeDeadline && !isRefusalNoticeShown) {
            isRefusalNoticeShown = document.body.textContent.includes('Not running: these plugins');
            if (!isRefusalNoticeShown) {
              await sleep(200);
            }
          }

          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline && Object.hasOwn(app.plugins.plugins, pluginId)) {
            await sleep(200);
          }

          return {
            enableError,
            isConflictEnabled: app.plugins.enabledPlugins.has(conflictingPluginId),
            isConflictRegistered,
            isLoadedAfter: Object.hasOwn(app.plugins.plugins, pluginId),
            isLoadedBefore,
            isRefusalNoticeShown,
            //  Unloads without saving, so the vault's config still lists it — that is what
            // Lets it come back by itself once the conflict is updated.
            isStillEnabledInConfig: app.plugins.enabledPlugins.has(pluginId),
            // Refusing to run must not uninstall anything — the user updates the conflict and it returns.
            isStillInstalled: Object.hasOwn(app.plugins.manifests, pluginId)
          };
        } finally {
          try {
            await app.plugins.disablePluginAndSave(conflictingPluginId);
          } catch {
            // Already off, or never on.
          }
          await adapter.rmdir(pluginFolder, true);
          await app.plugins.loadManifests();
          await app.plugins.enablePlugin(pluginId);
        }
      },
      input: {
        conflictingPluginId: CONFLICTING_PLUGIN_ID,
        conflictingPluginVersion: CONFLICTING_PLUGIN_VERSION,
        pluginId: PLUGIN_ID
      }
    });

    expect(result.enableError).toBeNull();
    expect(result.isRefusalNoticeShown).toBe(true);
    expect(result.isConflictRegistered).toBe(true);
    expect(result.isConflictEnabled).toBe(true);
    expect(result.isLoadedBefore).toBe(true);
    expect(result.isLoadedAfter).toBe(false);
    expect(result.isStillEnabledInConfig).toBe(true);
    expect(result.isStillInstalled).toBe(true);
  });
});
