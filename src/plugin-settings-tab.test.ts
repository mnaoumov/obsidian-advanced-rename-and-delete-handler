import type {
  App as AppOriginal,
  Plugin,
  SettingGroup
} from 'obsidian';
import type { PluginSettingsComponentBase } from 'obsidian-dev-utils/obsidian/components/plugin-settings-component';

import { noopAsync } from 'obsidian-dev-utils/function';
import { castTo } from 'obsidian-dev-utils/object-utils';
import { PluginSettingsTabBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-settings-tab';
import { SettingEx } from 'obsidian-dev-utils/obsidian/setting-ex';
import { strictProxy } from 'obsidian-dev-utils/strict-proxy';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { PluginSettingsTab } from './plugin-settings-tab.ts';
import { PluginSettings } from './plugin-settings.ts';

const EXPECTED_PROPERTY_NAMES = [
  'shouldHandleRenames',
  'shouldUpdateFileNameAliases',
  'shouldRenameAttachmentFolder',
  'shouldRenameAttachmentFiles',
  'shouldDeleteConflictingAttachments',
  'shouldHandleDeletions',
  'emptyFolderBehavior',
  'shouldRescueSharedAttachments',
  'notePriorities',
  'treatAsAttachmentExtensions',
  'includePaths',
  'excludePaths'
];

let app: AppOriginal;

beforeEach(() => {
  vi.clearAllMocks();
  app = App.createConfigured__().asOriginalType__();
  vi.spyOn(PluginSettingsTabBase.prototype, 'bind').mockImplementation((params) => params.valueComponent);
});

describe('PluginSettingsTab', () => {
  it('should declare a row for every setting the plugin owns', () => {
    const tab = createTab();

    renderRows(tab);

    expect(boundKeys()).toEqual(EXPECTED_PROPERTY_NAMES);
  });

  it('should lead with the setting that turns the plugin on', () => {
    expect(settingNames(createTab())[0]).toBe('Should handle renames');
  });

  it('should give every row a name', () => {
    for (const name of settingNames(createTab())) {
      expect(name).not.toBe('');
    }
  });

  it('should offer the three empty-folder behaviors', () => {
    const tab = createTab();
    const addedOptions: Record<string, string>[] = [];
    const setting = new SettingEx(tab.containerEl);
    vi.spyOn(setting, 'addDropdown').mockImplementation((callback) => {
      callback(castTo<Parameters<typeof callback>[0]>({
        addOptions: (options: Record<string, string>) => {
          addedOptions.push(options);
        }
      }));
      return setting;
    });

    const definition = tab.getSettingDefinitions().find((item) => 'name' in item && item.name === 'Empty folder behavior');
    if (!definition || !('render' in definition)) {
      throw new Error('The empty-folder row is missing.');
    }
    definition.render(setting, castTo<SettingGroup>(null));

    expect(Object.values(addedOptions[0] ?? {})).toEqual(['Keep', 'Delete', 'Delete with empty parents']);
  });

  it('should not expose the migration bookkeeping flag', () => {
    const tab = createTab();

    renderRows(tab);

    expect(boundKeys()).not.toContain('hasMigratedLegacySettings');
  });
});

function boundKeys(): unknown[] {
  return vi.mocked(PluginSettingsTabBase.prototype.bind).mock.calls.map((call) => call[0].propertyName);
}

function createMockSettingsComponent(): PluginSettingsComponentBase<PluginSettings> {
  const validationMessages = Object.fromEntries(EXPECTED_PROPERTY_NAMES.map((name) => [name, '']));
  return strictProxy<PluginSettingsComponentBase<PluginSettings>>({
    defaultSettings: new PluginSettings(),
    on: vi.fn().mockReturnValue({ asyncEventSource: { offref: vi.fn() } }),
    revalidate: vi.fn(() => Promise.resolve(validationMessages)),
    saveToFile: vi.fn(() => noopAsync()),
    setProperty: vi.fn(() => Promise.resolve('')),
    settingsState: {
      effectiveValues: new PluginSettings(),
      inputValues: new PluginSettings(),
      validationMessages
    }
  });
}

function createTab(): PluginSettingsTab {
  const plugin = strictProxy<Plugin>({
    app,
    manifest: { id: 'advanced-rename-delete-handler' }
  });
  return new PluginSettingsTab({
    plugin,
    pluginSettingsComponent: createMockSettingsComponent()
  });
}

/**
 * Invokes every declared row's `render` callback the way Obsidian does when the tab is opened, so the
 * bindings are still exercised now that the rows are declarative.
 *
 * @param tab - The settings tab.
 */
function renderRows(tab: PluginSettingsTab): void {
  for (const definition of tab.getSettingDefinitions()) {
    if ('render' in definition) {
      definition.render(new SettingEx(tab.containerEl), castTo<SettingGroup>(null));
    }
  }
}

/**
 * Reads the names of the declared rows.
 *
 * @param tab - The settings tab.
 * @returns The names.
 */
function settingNames(tab: PluginSettingsTab): string[] {
  return tab.getSettingDefinitions().map((definition) => 'name' in definition ? definition.name : '');
}
