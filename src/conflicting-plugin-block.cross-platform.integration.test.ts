import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * The behavior that distinguishes this plugin, driven end to end: with a plugin installed that still owns
 * its own rename/delete handler, this one stands aside rather than competing for control.
 *
 * A stub is installed under a conflicting plugin's id at a version the declared block covers, and this
 * plugin is then reloaded. BLOCKED MEANS ENABLED-BUT-INERT: the plugin stays in the vault's enabled list and
 * stays loaded, but its feature surface never runs — which is what stops two handlers acting on one rename.
 * `delete-empty-folders` is the surface this reads: it is registered by `onloadImpl`, so its absence from the
 * command palette is the externally visible proof that nothing behind the gate ran.
 *
 * Being loaded rather than disabled is not a detail — it is what lets the second half of this test pass.
 * Remove the conflict and the surface comes back, with the plugin never having left the user's enabled list
 * and nothing to switch back on by hand.
 *
 * The intermediate state is reported rather than awaited, so a setup that did not take (the stub never
 * registering, say) fails as a readable expectation instead of an opaque timeout.
 *
 * Cross-platform: a conflicting plugin is just as installable on a phone, and the manifest declares
 * `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const CONFLICTING_PLUGIN_ID = 'obsidian-custom-attachment-location';
const CONFLICTING_PLUGIN_VERSION = '11.10.0';

interface ConflictBlockResult {
  readonly enableError: null | string;
  readonly hasFeatureCommandAfter: boolean;
  readonly hasFeatureCommandBefore: boolean;
  readonly hasFeatureCommandOnRecovery: boolean;
  readonly isBlockedNoticeShown: boolean;
  readonly isConflictEnabled: boolean;
  readonly isConflictRegistered: boolean;
  readonly isLoadedAfter: boolean;
  readonly isLoadedBefore: boolean;
  readonly isStillEnabledInConfig: boolean;
  readonly isStillInstalled: boolean;
}

describe('A plugin that still owns its own rename/delete handler', () => {
  it('holds this plugin inert instead of competing, and lets it resume when the conflict goes', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        conflictingPluginId,
        conflictingPluginVersion,
        pluginId
      }): Promise<ConflictBlockResult> {
        /*
         * Under the transport's ~30s per-closure cap, not at it. The 10_400ms this closure declares is the
         * sum of the two deadline loops below plus one poll interval each, and both are worst cases for
         * steps that normally land in a couple of hundred milliseconds: the blocked notice appearing, and
         * the feature surface coming back once the conflict is gone.
         * The number that matters is that the worst case still fits inside the cap, so a run where both
         * deadlines expire fails on the assertions below, naming what did not happen, instead of dying as
         * a bare transport timeout naming only the harness.
         */
        const NOTICE_DEADLINE_IN_MILLISECONDS = 5000;
        const RECOVERY_DEADLINE_IN_MILLISECONDS = 5000;
        const POLL_INTERVAL_IN_MILLISECONDS = 200;

        const featureCommandId = `${pluginId}:delete-empty-folders`;

        function hasFeatureCommand(): boolean {
          return Object.hasOwn(app.commands.commands, featureCommandId);
        }

        const pluginFolder = `${app.vault.configDir}/plugins/${conflictingPluginId}`;
        const adapter = app.vault.adapter;

        const isLoadedBefore = Object.hasOwn(app.plugins.plugins, pluginId);
        const hasFeatureCommandBefore = hasFeatureCommand();
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

          // Reload this plugin so its gate is evaluated with the stub present.
          await app.plugins.disablePlugin(pluginId);
          await app.plugins.enablePlugin(pluginId);

          // Did the gate close at all? Its notice is the only externally visible evidence.
          let isBlockedNoticeShown = false;
          const noticeDeadline = Date.now() + NOTICE_DEADLINE_IN_MILLISECONDS;
          while (Date.now() < noticeDeadline && !isBlockedNoticeShown) {
            isBlockedNoticeShown = document.body.textContent.includes('does nothing while');
            if (!isBlockedNoticeShown) {
              await sleep(POLL_INTERVAL_IN_MILLISECONDS);
            }
          }

          const blockedState = {
            hasFeatureCommandAfter: hasFeatureCommand(),
            isBlockedNoticeShown,
            isConflictEnabled: app.plugins.enabledPlugins.has(conflictingPluginId),
            isConflictRegistered,
            // Blocked is enabled-but-inert: it is still LOADED, unlike the self-disabling guard this
            // Replaced, so there is nothing for the user to switch back on.
            isLoadedAfter: Object.hasOwn(app.plugins.plugins, pluginId),
            isStillEnabledInConfig: app.plugins.enabledPlugins.has(pluginId),
            // Standing aside must not uninstall anything — the user updates the conflict and it returns.
            isStillInstalled: Object.hasOwn(app.plugins.manifests, pluginId)
          };

          // And now the other half: take the conflict away and the surface comes back.
          await app.plugins.disablePluginAndSave(conflictingPluginId);
          await adapter.rmdir(pluginFolder, true);
          await app.plugins.loadManifests();
          await app.plugins.disablePlugin(pluginId);
          await app.plugins.enablePlugin(pluginId);

          let hasFeatureCommandOnRecovery = false;
          const recoveryDeadline = Date.now() + RECOVERY_DEADLINE_IN_MILLISECONDS;
          while (Date.now() < recoveryDeadline && !hasFeatureCommandOnRecovery) {
            hasFeatureCommandOnRecovery = hasFeatureCommand();
            if (!hasFeatureCommandOnRecovery) {
              await sleep(POLL_INTERVAL_IN_MILLISECONDS);
            }
          }

          return {
            ...blockedState,
            enableError,
            hasFeatureCommandBefore,
            hasFeatureCommandOnRecovery,
            isLoadedBefore
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
    expect(result.isConflictRegistered).toBe(true);
    expect(result.isConflictEnabled).toBe(true);
    expect(result.isLoadedBefore).toBe(true);
    expect(result.hasFeatureCommandBefore).toBe(true);

    expect(result.isBlockedNoticeShown).toBe(true);
    expect(result.isLoadedAfter).toBe(true);
    expect(result.hasFeatureCommandAfter).toBe(false);
    expect(result.isStillEnabledInConfig).toBe(true);
    expect(result.isStillInstalled).toBe(true);

    expect(result.hasFeatureCommandOnRecovery).toBe(true);
  });
});
