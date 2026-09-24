import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * The settings tab's answer to "why is this plugin in my vault", driven end to end: a plugin that declares this
 * one as a dependency announces it on `app.workspace`, and this plugin's own settings tab lists it with a
 * button to its settings.
 *
 * The dependent is the broadcast itself rather than an installed plugin. That broadcast is the contract — any
 * plugin built on `obsidian-dev-utils` 101.7 or later makes exactly this call once its dependency gate has
 * opened — and staging it directly keeps this suite independent of another plugin's release. The id it
 * announces is Obsidian's own `editor` settings tab, so the button has a real tab to open and the suite can
 * see that it opened.
 *
 * Cross-platform: the manifest declares `isDesktopOnly: false`, and the settings tab renders on a phone too.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const DEPENDENT_PLUGIN_ID = 'editor';
const DEPENDENT_PLUGIN_NAME = 'A dependent plugin';
const DEPENDENTS_HEADING = 'Plugins that depend on this one';

/*
 * Under the transport's ~30s per-closure cap, not at it. The whole closure is one transport call, so what
 * matters is the SUM of what it declares, not what any single wait asks for — and this budget is charged
 * SEVEN times: `openOwnTab` runs three times, `closeSettings` twice, and two more waits are written in the
 * closure's own body, for 28 000 ms in total. At 20_000 the sum was 100 000 with five charges, four times a
 * cap the call would have been killed at first, reported as a bare transport timeout naming the harness
 * rather than the wait that overran.
 *
 * Every one of the seven waits on a settings modal opening or closing or a settings row appearing, which
 * land in a frame or two, so a fifth of the old number costs nothing. There is no long step here to move to
 * `pollInObsidian`.
 */
const WAIT_TIMEOUT_IN_MILLISECONDS = 4000;

interface DependentsProbeResult {
  readonly buttonTexts: string[];
  readonly isHeadingShownAfterUnload: boolean;
  readonly isHeadingShownBefore: boolean;
  readonly openedTabId: string;
}

describe('A plugin that declares this one as a dependency', () => {
  it('is listed in this plugin\'s settings tab, with a button to its own settings', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        dependentPluginId,
        dependentPluginName,
        dependentsHeading,
        lib: { waitUntil },
        pluginId,
        timeoutInMilliseconds
      }): Promise<DependentsProbeResult> {
        const payload = {
          apiVersions: [],
          dependencyPluginIds: [pluginId],
          pluginId: dependentPluginId,
          pluginName: dependentPluginName,
          pluginVersion: '1.0.0'
        };

        function isHeadingShown(): boolean {
          const containerEl = app.setting.activeTab?.containerEl;
          if (!containerEl) {
            return false;
          }

          // Matched by text on a leaf element rather than by class: what is asserted is that the heading is on
          // Screen, whichever element Obsidian's group renderer puts it in.
          return [...containerEl.querySelectorAll<HTMLElement>('*')]
            .some((el) => el.childElementCount === 0 && el.textContent === dependentsHeading && el.isShown());
        }

        /*
         * On a phone, `close()` is not finished when it returns: the modal detaches a beat later, and a tab
         * selected while it is still leaving is dropped when it goes, leaving `activeTab` undefined. Reopening
         * straight after a close therefore passed `openOwnTab`'s id check and then showed no tab at all — so the
         * dependents group never appeared, and each false `isHeadingShown()` read after a reopen was read off an
         * empty modal. Pausing before `openTabById` did not help; waiting for the detach did. Only the Android
         * run ever failed this way.
         */
        async function closeSettings(): Promise<void> {
          app.setting.close();
          await waitUntil({
            message: 'the settings modal closes',
            predicate: () => !app.setting.containerEl.isConnected,
            timeoutInMilliseconds
          });
        }

        async function openOwnTab(): Promise<void> {
          app.setting.open();
          app.setting.openTabById(pluginId);
          await waitUntil({
            message: 'this plugin\'s settings tab opens',
            predicate: () => app.setting.activeTab?.id === pluginId && app.setting.activeTab.containerEl.isShown(),
            timeoutInMilliseconds
          });
        }

        try {
          await openOwnTab();
          const isHeadingShownBefore = isHeadingShown();
          await closeSettings();

          app.workspace.trigger('obsidian-dev-utils:plugin-loaded', payload);
          await openOwnTab();
          await waitUntil({
            message: 'the dependents group appears',
            predicate: isHeadingShown,
            timeoutInMilliseconds
          });

          const containerEl = app.setting.activeTab?.containerEl;
          const buttons = [...(containerEl?.querySelectorAll('button') ?? [])].filter((button) => button.textContent.startsWith(dependentPluginName));
          const buttonTexts = buttons.map((button) => button.textContent);

          buttons[0]?.click();
          await waitUntil({
            message: 'the dependent\'s settings tab opens',
            predicate: () => app.setting.activeTab?.id === dependentPluginId,
            timeoutInMilliseconds
          });
          const openedTabId = app.setting.activeTab?.id ?? '';
          await closeSettings();

          app.workspace.trigger('obsidian-dev-utils:plugin-unloaded', payload);
          await openOwnTab();
          const isHeadingShownAfterUnload = isHeadingShown();

          return {
            buttonTexts,
            isHeadingShownAfterUnload,
            isHeadingShownBefore,
            openedTabId
          };
        } finally {
          // Unloaded even when an assertion above threw, so no later suite inherits a phantom dependent.
          app.workspace.trigger('obsidian-dev-utils:plugin-unloaded', payload);
          app.setting.close();
        }
      },
      input: {
        dependentPluginId: DEPENDENT_PLUGIN_ID,
        dependentPluginName: DEPENDENT_PLUGIN_NAME,
        dependentsHeading: DEPENDENTS_HEADING,
        pluginId: PLUGIN_ID,
        timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
      }
    });

    expect(result.isHeadingShownBefore).toBe(false);
    expect(result.buttonTexts).toEqual([`${DEPENDENT_PLUGIN_NAME} 1.0.0`]);
    expect(result.openedTabId).toBe(DEPENDENT_PLUGIN_ID);
    expect(result.isHeadingShownAfterUnload).toBe(false);
  });
});
