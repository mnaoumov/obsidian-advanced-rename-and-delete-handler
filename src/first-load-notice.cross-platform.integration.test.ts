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
 * The first-load notice, driven end to end: a vault with no `data.json` for this plugin is told, once, that the
 * plugin does nothing until something is turned on, and the file is written so the next load stays quiet.
 *
 * A missing `data.json` is the state of a fresh install and of an upgrade by a user who never changed a
 * setting — the user the no-op defaults would otherwise silently switch off. The suite reproduces it the only
 * way a real vault reaches it: the file is removed and the plugin is loaded again.
 *
 * Cross-platform: the manifest declares `isDesktopOnly: false`, and a phone reaches the same state.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const NOTICE_TEXT = 'doing nothing yet';

/*
 * Under the transport's ~30s per-closure cap, not at it. The whole closure is one transport call, so what
 * matters is the SUM of what it declares, not what any single wait asks for — and this budget is charged
 * FOUR times across `reloadPlugin`, `dismissNotice` and the closure's own body, for 28 000 ms in total. At
 * 20_000 the sum was 80 000, well past a cap the call would have been killed at first and reported as a bare
 * transport timeout naming the harness rather than the wait that overran.
 *
 * The longest of the four is a plugin disable/enable round trip, which is a load of this one plugin rather
 * than of the vault, so seven seconds is generous for it. There is no long step here to move to
 * `pollInObsidian`.
 */
const WAIT_TIMEOUT_IN_MILLISECONDS = 7000;

interface FirstLoadProbeResult {
  readonly doesDataFileExistAfter: boolean;
  readonly isNoticeShownAgainOnReload: boolean;
  readonly noticeText: string;
  readonly openedTabId: string;
}

// The one field of the `obsidian-dev-utils:plugin-loaded` payload this suite reads.
interface PluginLoadedPayloadLike {
  readonly pluginId: string;
}

let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('Loading into a vault with no data.json for this plugin', () => {
  it('says once that the plugin does nothing yet, opens its settings from the notice, and writes the file', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: { waitUntil },
        noticeText,
        pluginId,
        timeoutInMilliseconds
      }): Promise<FirstLoadProbeResult> {
        const dataPath = `${app.vault.configDir}/plugins/${pluginId}/data.json`;
        const adapter = app.vault.adapter;

        function findNotice(): HTMLElement | null {
          return [...document.querySelectorAll<HTMLElement>('.notice')].find((noticeEl) => noticeEl.textContent.includes(noticeText)) ?? null;
        }

        /*
         * A notice fades out rather than vanishing, so one dismissed a moment ago is still in the DOM. Waiting for
         * it to go is what keeps an old notice from being read as a new one.
         */
        async function dismissNotice(): Promise<void> {
          findNotice()?.click();
          await waitUntil({
            message: 'the previous notice is gone',
            predicate: () => findNotice() === null,
            timeoutInMilliseconds
          });
        }

        /*
         * The `plugin-loaded` broadcast is the end of the load: the base sends it only after every child — the
         * first-load notice included — has finished loading. So once it arrives, the notice has been shown or
         * decided against, and the file has been written or left alone.
         */
        async function reloadPlugin(prepare: () => Promise<void>): Promise<void> {
          let isLoaded = false;
          const eventRef = app.workspace.on('obsidian-dev-utils:plugin-loaded', (payload: PluginLoadedPayloadLike) => {
            if (payload.pluginId === pluginId) {
              isLoaded = true;
            }
          });

          try {
            await app.plugins.disablePlugin(pluginId);
            await prepare();
            await app.plugins.enablePlugin(pluginId);
            await waitUntil({
              message: 'the plugin finishes loading',
              predicate: () => isLoaded,
              timeoutInMilliseconds
            });
          } finally {
            app.workspace.offref(eventRef);
          }
        }

        await reloadPlugin(async () => {
          // The harness vault may have shown this very notice at startup, for the same reason.
          await dismissNotice();
          if (await adapter.exists(dataPath)) {
            await adapter.remove(dataPath);
          }
        });

        const noticeEl = findNotice();
        const shownText = noticeEl?.textContent ?? '';
        const doesDataFileExistAfter = await adapter.exists(dataPath);

        let openedTabId = '';
        const button = noticeEl?.querySelector('button');
        if (button) {
          button.click();
          await waitUntil({
            message: 'the notice button opens a settings tab',
            predicate: () => app.setting.activeTab !== null,
            timeoutInMilliseconds
          });
          openedTabId = app.setting.activeTab?.id ?? '';
          app.setting.close();
        }

        // The file is there now, so loading again must stay quiet.
        await reloadPlugin(dismissNotice);
        const isNoticeShownAgainOnReload = findNotice() !== null;

        return {
          doesDataFileExistAfter,
          isNoticeShownAgainOnReload,
          noticeText: shownText,
          openedTabId
        };
      },
      input: {
        noticeText: NOTICE_TEXT,
        pluginId: PLUGIN_ID,
        timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
      }
    });

    expect(result.noticeText).toContain('Should handle renames');
    expect(result.noticeText).toContain('rename handling used to be on');
    expect(result.openedTabId).toBe(PLUGIN_ID);
    expect(result.doesDataFileExistAfter).toBe(true);
    expect(result.isNoticeShownAgainOnReload).toBe(false);
  });
});
