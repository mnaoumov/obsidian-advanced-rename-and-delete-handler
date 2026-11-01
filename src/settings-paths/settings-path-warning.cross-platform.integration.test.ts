import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * A folder named in another plugin's settings moves, and `shouldWarnAboutPathsInSettings` names that setting once the
 * batch settles. The other plugin is a `data.json` in a plugin folder of its own, with no plugin behind it: the
 * warner reads the file, so nothing more is needed, and nothing is loaded that could rewrite it first.
 *
 * The setting is not in the published API, so it goes in through `configureCommunityPlugin`, and the closure puts
 * back what `data.json` held.
 *
 * Cross-platform: plugin settings live in the vault on phones too.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';

describe('Paths in other plugins\' settings after a rename', () => {
  it('are named in one notice', async () => {
    const noticeTexts = await renameAndCollectNotices();

    expect(noticeTexts).toEqual([
      expect.stringContaining('rdh-settings-path-plugin: watched.folder = rdh-settings-path/Templates/Daily → rdh-settings-path/Meta/Daily')
    ]);
  });
});

async function renameAndCollectNotices(): Promise<string[]> {
  return await evalInObsidian({
    async callback({
      app,
      lib: {
        configureCommunityPlugin,
        waitUntil
      },
      pluginId
    }): Promise<string[]> {
      const FOLDER = 'rdh-settings-path';
      const FAKE_PLUGIN_FOLDER = `${app.vault.configDir}/plugins/rdh-settings-path-plugin`;
      // Under the transport's ~30s per-closure cap, not at it. Charged once: the batch settles a second after the move.
      const WAIT_TIMEOUT_IN_MILLISECONDS = 10_000;

      const dataPath = `${app.vault.configDir}/plugins/${pluginId}/data.json`;
      const originalData = await app.vault.adapter.exists(dataPath)
        ? JSON.parse(await app.vault.adapter.read(dataPath)) as Record<string, unknown>
        : {};
      const originalShouldWarn = originalData['shouldWarnAboutPathsInSettings'] ?? false;

      try {
        await configureCommunityPlugin({
          app,
          pluginId,
          settings: { shouldWarnAboutPathsInSettings: true }
        });

        await app.vault.adapter.mkdir(FAKE_PLUGIN_FOLDER);
        await app.vault.adapter.write(`${FAKE_PLUGIN_FOLDER}/data.json`, JSON.stringify({ watched: { folder: `${FOLDER}/Templates/Daily` } }));
        await app.vault.createFolder(`${FOLDER}/Templates/Daily`);
        await app.vault.create(`${FOLDER}/Templates/Daily/template.md`, '');
        const noticesBefore = new Set(document.querySelectorAll('.notice'));

        const templatesFolder = app.vault.getFolderByPath(`${FOLDER}/Templates`);
        if (!templatesFolder) {
          throw new Error('the templates folder was not created');
        }

        await app.fileManager.renameFile(templatesFolder, `${FOLDER}/Meta`);
        await waitUntil({
          message: 'the settings warning is shown once the batch settles',
          predicate: () => [...document.querySelectorAll('.notice')].some((noticeEl) => !noticesBefore.has(noticeEl) && noticeEl.textContent.includes('Renamed paths')),
          timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
        });

        return [...document.querySelectorAll('.notice')]
          .filter((noticeEl) => !noticesBefore.has(noticeEl))
          .map((noticeEl) => noticeEl.textContent)
          .filter((text) => text.includes('Renamed paths'));
      } finally {
        await configureCommunityPlugin({
          app,
          pluginId,
          settings: { shouldWarnAboutPathsInSettings: originalShouldWarn }
        });
        if (await app.vault.adapter.exists(FAKE_PLUGIN_FOLDER)) {
          await app.vault.adapter.rmdir(FAKE_PLUGIN_FOLDER, true);
        }

        // Through the adapter, so the teardown does not travel back through the delete path this plugin patches.
        if (await app.vault.adapter.exists(FOLDER)) {
          await app.vault.adapter.rmdir(FOLDER, true);
        }
      }
    },
    input: {
      pluginId: PLUGIN_ID
    }
  });
}
