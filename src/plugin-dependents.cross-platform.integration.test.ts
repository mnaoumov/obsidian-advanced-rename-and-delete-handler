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
const WAIT_TIMEOUT_IN_MILLISECONDS = 20_000;

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

        async function openOwnTab(): Promise<void> {
          app.setting.open();
          app.setting.openTabById(pluginId);
          await waitUntil({
            message: 'this plugin\'s settings tab opens',
            predicate: () => app.setting.activeTab?.id === pluginId,
            timeoutInMilliseconds
          });
        }

        try {
          await openOwnTab();
          const isHeadingShownBefore = isHeadingShown();
          app.setting.close();

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
          app.setting.close();

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
