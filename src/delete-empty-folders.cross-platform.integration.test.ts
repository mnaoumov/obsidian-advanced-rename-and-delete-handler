import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * The manual `Delete empty folders` sweep, inherited from `obsidian-consistent-attachments-and-links` when
 * that plugin's scope stopped covering folder management. The automatic half — cleaning up a folder a
 * deletion or a move has just emptied — moved here a release earlier, as `emptyFolderBehavior`.
 *
 * What this pins is the decision no unit test can reach: **the sweep runs under
 * `EmptyFolderBehavior.Keep`**, which is the plugin's default. `Keep` governs a folder emptied
 * incidentally, by a deletion the user asked for something else; invoking this command is the user naming
 * the folders themselves. In `delete-empty-folders.test.ts` the behavior is an argument, so a regression
 * that made the command a no-op on a default install would pass every assertion there.
 *
 * **It writes no settings, deliberately.** `emptyFolderBehavior` is left at its default rather than set to
 * `Keep`, which is what makes this a test of a real default install — and it keeps the suite out of the
 * `migrateSettings` dialog. That API is queued and its modal is the only one on screen, so a suite that
 * opens one while another suite is waiting for its own can dismiss the wrong dialog; eleven suites here
 * already share that hazard and this one has no need to join them. No other suite writes
 * `emptyFolderBehavior`, so the default holds for the whole run.
 *
 * The include/exclude half of the sweep is covered without a vault: `delete-empty-folders.test.ts` pins the
 * filtering, and `command-handlers/delete-empty-folders-command-handler.test.ts` pins the routing through a
 * real `PluginSettings.isPathIgnored`.
 *
 * **This suite is the one that acts on the WHOLE vault**, in a vault the desktop aggregate shares between
 * concurrently-running files. The sweep only ever removes a folder that is empty at the instant it is
 * checked, so a sibling suite's fixture is at risk only in the gap between its `createFolder` and the first
 * file it puts there — microseconds, inside one closure. Measured over five aggregate runs it caused no
 * sibling failure. Worth knowing before adding a suite that leaves a folder deliberately empty across an
 * await: that one would need its own vault, the way `desktop-performance` has.
 *
 * Cross-platform: an empty folder accumulates on a phone exactly as it does on a desktop, and the manifest
 * declares `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';

interface SweepResult {
  readonly doesNestedEmptyFolderExist: boolean;
  readonly doesPopulatedFolderExist: boolean;
  readonly doesRootFolderExist: boolean;
  readonly doesTopEmptyFolderExist: boolean;
}

describe('The manual Delete empty folders sweep', () => {
  it('clears an empty tree under the default Keep behavior, leaving a folder that still holds a file', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: { waitUntil },
        pluginId
      }): Promise<SweepResult> {
        const ROOT = 'rdh-empty-folder-sweep';
        const TOP_EMPTY = `${ROOT}/empty`;
        const NESTED_EMPTY = `${TOP_EMPTY}/nested`;
        const POPULATED = `${ROOT}/populated`;
        const POPULATED_NOTE = `${POPULATED}/kept.md`;
        const WAIT_TIMEOUT_IN_MILLISECONDS = 30_000;

        const plugin = app.plugins.plugins[pluginId];
        if (!plugin) {
          throw new Error(`${pluginId} is not loaded`);
        }

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          await app.vault.createFolder(ROOT);
          await app.vault.createFolder(TOP_EMPTY);
          await app.vault.createFolder(NESTED_EMPTY);
          await app.vault.createFolder(POPULATED);
          await app.vault.create(POPULATED_NOTE, '# Kept\n');

          app.commands.executeCommandById(`${pluginId}:delete-empty-folders`);

          /*
           * The command is fire-and-forget — its `checkCallback` cannot await — so the sweep is observed by
           * its effect. The wait is on the PARENT, not the nested folder: the pass runs deepest first, so
           * the parent is the later of the two, and waiting on the child would let the assertions read the
           * vault while the parent was still queued.
           */
          await waitUntil({
            message: 'the sweep removes the empty folder left by its own emptied child',
            predicate: async () => !await app.vault.adapter.exists(TOP_EMPTY),
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          return {
            doesNestedEmptyFolderExist: await app.vault.adapter.exists(NESTED_EMPTY),
            doesPopulatedFolderExist: await app.vault.adapter.exists(POPULATED),
            doesRootFolderExist: await app.vault.adapter.exists(ROOT),
            doesTopEmptyFolderExist: await app.vault.adapter.exists(TOP_EMPTY)
          };
        } finally {
          /*
           * Through the adapter, as the sibling suites do: a fixture teardown must not travel back through
           * the very delete path this plugin patches, which would make the cleanup part of what is tested.
           */
          if (await app.vault.adapter.exists(ROOT)) {
            await app.vault.adapter.rmdir(ROOT, true);
          }
        }
      },
      input: { pluginId: PLUGIN_ID }
    });

    // The tree goes bottom-up in one pass: the parent is examined after the child that emptied it.
    expect(result.doesNestedEmptyFolderExist).toBe(false);
    expect(result.doesTopEmptyFolderExist).toBe(false);

    // A folder still holding a file is left alone, and so is the root that still holds that folder.
    expect(result.doesPopulatedFolderExist).toBe(true);
    expect(result.doesRootFolderExist).toBe(true);
  });
});
