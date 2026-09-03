import type {
  App as AppOriginal,
  Plugin,
  SettingDefinition,
  SettingDefinitionGroup,
  SettingDefinitionItem,
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
  'rescueAttachmentUsedByMultipleNotesMode',
  'treatAsAttachmentExtensions',
  'includePaths',
  'excludePaths'
];

const EXPECTED_HEADINGS = [
  'Renames and moves',
  'Deletions',
  'Scope'
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

  it('should group the rows under the three headings', () => {
    expect(headings(createTab())).toEqual(EXPECTED_HEADINGS);
  });

  it('should put every row inside a group, leaving none loose at the top level', () => {
    for (const item of createTab().getSettingDefinitions()) {
      expect(item).toHaveProperty('items');
    }
  });

  it('should lead each group with the switch that turns its behavior on', () => {
    const tab = createTab();

    expect(firstRowNamePerGroup(tab)).toEqual([
      'Should handle renames',
      'Should handle deletions',
      'Treat as attachment extensions'
    ]);
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

    const definition = flattenRows(tab.getSettingDefinitions()).find((row) => row.name === 'Empty folder behavior');
    if (!definition || !('render' in definition)) {
      throw new Error('The empty-folder row is missing.');
    }
    definition.render(setting, castTo<SettingGroup>(null));

    expect(Object.values(addedOptions[0] ?? {})).toEqual(['Keep', 'Delete', 'Delete with empty parents']);
  });

  it('should expose no setting the plugin does not own', () => {
    const tab = createTab();

    renderRows(tab);

    expect(boundKeys()).toHaveLength(EXPECTED_PROPERTY_NAMES.length);
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
    manifest: { id: 'advanced-rename-and-delete-handler' }
  });
  return new PluginSettingsTab({
    plugin,
    pluginSettingsComponent: createMockSettingsComponent()
  });
}

/**
 * Reads the name of the first row of each group, which is the switch the rest of that group depends on.
 *
 * @param tab - The settings tab.
 * @returns The names, one per group.
 */
function firstRowNamePerGroup(tab: PluginSettingsTab): string[] {
  return groups(tab).map((group) => flattenRows(castTo<SettingDefinitionItem[]>(group.items ?? []))[0]?.name ?? '');
}

/**
 * Flattens declared items into leaf rows, descending into groups and sub-pages alike.
 *
 * Both a group and a page carry their children in `items`, so the walk has to recurse.
 *
 * @param items - The declared items.
 * @returns The leaf rows.
 */
function flattenRows(items: SettingDefinitionItem[]): SettingDefinition[] {
  const rows: SettingDefinition[] = [];
  for (const item of items) {
    if ('items' in item) {
      rows.push(...flattenRows(castTo<SettingDefinitionItem[]>(item.items ?? [])));
      continue;
    }

    rows.push(castTo<SettingDefinition>(item));
  }

  return rows;
}

/**
 * Reads the group definitions of the tab.
 *
 * @param tab - The settings tab.
 * @returns The groups.
 */
function groups(tab: PluginSettingsTab): SettingDefinitionGroup[] {
  return tab.getSettingDefinitions().filter((item) => 'items' in item).map((item) => castTo<SettingDefinitionGroup>(item));
}

/**
 * Reads the group headings, in the order they are declared.
 *
 * @param tab - The settings tab.
 * @returns The headings.
 */
function headings(tab: PluginSettingsTab): string[] {
  return groups(tab).map((group) => group.heading ?? '');
}

/**
 * Renders the declared rows the way Obsidian does when the tab is opened: it descends into the groups,
 * applies the name and description, and runs each row's `render` callback.
 *
 * No row in this tab declares a `visible` or `disabled` predicate, so the predicate-evaluating half of
 * G101's reference renderer is deliberately absent — it would be a branch no test can take, against a
 * 100% coverage gate. Add it back the moment a row grows a predicate.
 *
 * @param tab - The settings tab.
 */
function renderRows(tab: PluginSettingsTab): void {
  for (const row of flattenRows(tab.getSettingDefinitions())) {
    if (!('render' in row)) {
      continue;
    }

    const setting = new SettingEx(tab.containerEl);
    setting.setName(row.name);
    if (row.desc) {
      setting.setDesc(row.desc);
    }

    row.render(setting, castTo<SettingGroup>(null));
  }
}

/**
 * Reads the names of the declared rows, descending into the groups.
 *
 * @param tab - The settings tab.
 * @returns The names.
 */
function settingNames(tab: PluginSettingsTab): string[] {
  return flattenRows(tab.getSettingDefinitions()).map((row) => row.name);
}
