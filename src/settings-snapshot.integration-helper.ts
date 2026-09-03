/**
 * @file
 *
 * Snapshotting this plugin's settings around an integration suite, so one suite's staging is not the next
 * suite's starting point.
 *
 * A desktop or Android run drives EVERY suite against ONE Obsidian instance. The vault is fresh per run, but
 * the app — and with it the loaded plugin and the settings it holds — outlives each test file. Eleven suites
 * write settings through `api.migrateSettings` to stage what they are about to test, and their `finally`
 * blocks put back `attachmentFolderPath` and `alwaysUpdateLinks` but never the plugin settings, so whatever
 * the last file left behind became the next file's starting point.
 *
 * That would be survivable if the order were fixed. It is not: vitest's default sequencer runs previously
 * FAILED files first and then previously SLOWEST first, from a cache every run rewrites — so the order
 * changes from run to run with nothing in the repo changing. That is the whole of the intermittent aggregate
 * failure this module exists to end: `shared-attachment-tie` stages exactly the two values
 * `settings-migration` proposes, so whenever it sorted ahead, that proposal changed nothing,
 * `PluginApiImpl.migrateSettings` took its no-op path without opening a dialog, and the suite waited 20s for
 * a dialog that was never coming. Half of all runs, on any branch.
 *
 * The settings are read and restored through the plugin's own public API — the same surface a consumer
 * plugin uses — so this adds no test-only production code. The snapshot is carried opaquely rather than
 * field by field: `getSettings` and `migrateSettings` are two halves of one contract
 * (`MigratableSettings = Partial<HandedOverSettings>`), so handing back exactly what was read restores
 * everything the API can reach, including settings added later that this file has never heard of.
 *
 * Each callback below reaches the API on its own rather than through a shared helper: `evalInObsidian`
 * serializes a callback by its source, so a function it merely closes over does not exist on the other side.
 */

import { evalInObsidian } from 'obsidian-integration-testing';

/**
 * The settings a suite found when it started, carried back once the suite is done.
 *
 * Deliberately opaque: it is whatever `getSettings` returned, and it goes back unread.
 */
export type PluginSettingsSnapshot = Readonly<Record<string, unknown>>;

const PLUGIN_ID = 'advanced-rename-and-delete-handler';

/**
 * The `manifest.id` the restore proposes under — the same one every suite stages with, because the restore
 * is that staging run backwards rather than a second consumer.
 */
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

const WAIT_TIMEOUT_IN_MILLISECONDS = 30_000;

interface MigrateSettingsParamsLike {
  readonly proposedSettings: PluginSettingsSnapshot;
  readonly sourcePluginId: string;
}

interface MigrateSettingsResultLike {
  readonly isApplied: boolean;
}

interface PluginApiLike {
  getSettings(): PluginSettingsSnapshot;
  migrateSettings(params: MigrateSettingsParamsLike): Promise<MigrateSettingsResultLike>;
}

interface PluginWithApiLike {
  readonly api: PluginApiLike;
}

/**
 * Reads the settings this plugin holds right now.
 *
 * Call it from `beforeAll`, before the suite stages anything of its own.
 *
 * @returns The snapshot to hand to {@link writePluginSettings} once the suite is done.
 */
export async function readPluginSettings(): Promise<PluginSettingsSnapshot> {
  return await evalInObsidian({
    callback({
      app,
      pluginId
    }): PluginSettingsSnapshot {
      const plugin = app.plugins.plugins[pluginId];
      if (!plugin) {
        throw new Error(`${pluginId} is not loaded`);
      }

      // eslint-disable-next-line unicorn/consistent-function-scoping -- The callback is serialized by its source and evaluated inside Obsidian, so a helper hoisted out of it would not exist there.
      function hasApi(candidate: object): candidate is PluginWithApiLike {
        return 'api' in candidate;
      }

      if (!hasApi(plugin)) {
        throw new Error(`${pluginId} exposes no API`);
      }

      return plugin.api.getSettings();
    },
    input: { pluginId: PLUGIN_ID }
  });
}

/**
 * Puts a snapshot back, approving the dialog the proposal raises.
 *
 * Call it from `afterAll`. A snapshot that already matches what the plugin holds — the suite changed nothing,
 * or changed it back — raises no dialog at all, so the wait settles on either outcome rather than insisting
 * on a modal that may never appear. That is the very trap this module exists to close, so it is not repeated
 * here.
 *
 * @param snapshot - What {@link readPluginSettings} returned.
 */
export async function writePluginSettings(snapshot: PluginSettingsSnapshot): Promise<void> {
  await evalInObsidian({
    async callback({
      app,
      lib: { waitUntil },
      pluginId,
      proposedSettings,
      sourcePluginId,
      waitTimeoutInMilliseconds
    }): Promise<void> {
      const plugin = app.plugins.plugins[pluginId];
      if (!plugin) {
        throw new Error(`${pluginId} is not loaded`);
      }

      // eslint-disable-next-line unicorn/consistent-function-scoping -- The callback is serialized by its source and evaluated inside Obsidian, so a helper hoisted out of it would not exist there.
      function hasApi(candidate: object): candidate is PluginWithApiLike {
        return 'api' in candidate;
      }

      if (!hasApi(plugin)) {
        throw new Error(`${pluginId} exposes no API`);
      }

      /*
       * A modal already on screen is one a failing test left open. Proposing over it would find THAT dialog
       * below, approve whatever it was asking, and then wait forever for the restore's own dialog to be
       * answered — turning one reported failure into a hook timeout that names nothing. Say what happened
       * instead.
       */
      if (document.querySelector('.modal-container')) {
        throw new Error('a modal was left open by a failing test, so the settings snapshot was not restored');
      }

      const migrationPromise = plugin.api.migrateSettings({
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
        message: 'the settings dialog opens, or the snapshot turns out to match what is already there',
        predicate: () => isSettled || document.querySelector('.modal-container') !== null,
        timeoutInMilliseconds: waitTimeoutInMilliseconds
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
        throw new Error('the settings snapshot was not restored');
      }
    },
    input: {
      pluginId: PLUGIN_ID,
      proposedSettings: snapshot,
      sourcePluginId: SOURCE_PLUGIN_ID,
      waitTimeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
    }
  });
}
