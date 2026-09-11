import type {
  App as AppOriginal,
  Plugin,
  SettingDefinition,
  SettingDefinitionGroup,
  SettingDefinitionItem,
  SettingDefinitionRender,
  SettingGroup
} from 'obsidian';
import type { PluginGateComponent } from 'obsidian-dev-utils/obsidian/components/plugin-gate-component';
import type { PluginSettingsComponentBase } from 'obsidian-dev-utils/obsidian/components/plugin-settings-component';
import type { PluginLifecycleEventPayload } from 'obsidian-dev-utils/obsidian/plugin/plugin-lifecycle-events';

import { noopAsync } from 'obsidian-dev-utils/function';
import { castTo } from 'obsidian-dev-utils/object-utils';
import {
  PLUGIN_LOADED_EVENT_NAME,
  PLUGIN_UNLOADED_EVENT_NAME
} from 'obsidian-dev-utils/obsidian/plugin/plugin-lifecycle-events';
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

import { PluginDependentsComponent } from './plugin-dependents-component.ts';
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

const DEPENDENTS_HEADING = 'Plugins that depend on this one';

const EXPECTED_HEADINGS = [
  DEPENDENTS_HEADING,
  'Renames and moves',
  'Deletions',
  'Scope'
];

const PLUGIN_ID = 'advanced-rename-and-delete-handler';

interface AppSettingLike {
  openTabById: ReturnType<typeof vi.fn>;
}

// The obsidian-test-mocks button: its DOM element is inert, and the registered handler runs through here.
interface ButtonComponentMock {
  readonly buttonEl: HTMLButtonElement;
  simulateClick__(): void;
}

interface SettingLike {
  setting: AppSettingLike;
}

// The overlap banner's single input. Whether it writes anything is what decides the row's fate, since the
// Row hides itself when the library renders nothing.
const renderConflictWarningBannerMock = vi.fn<(containerEl: HTMLElement) => void>();

let app: AppOriginal;
let pluginDependentsComponent: PluginDependentsComponent;

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` drops the recorded calls but keeps any implementation set by an earlier test, and
  // Whether this one writes into the container is exactly what the overlap row's tests differ on.
  renderConflictWarningBannerMock.mockReset();
  app = App.createConfigured__().asOriginalType__();
  // `app.setting` is the one member the dependents row reaches that obsidian-test-mocks does not model.
  castTo<SettingLike>(app).setting = { openTabById: vi.fn() };
  vi.spyOn(PluginSettingsTabBase.prototype, 'bind').mockImplementation((params) => params.valueComponent);
  pluginDependentsComponent = new PluginDependentsComponent({ app, pluginId: PLUGIN_ID });
  pluginDependentsComponent.load();
});

describe('PluginSettingsTab', () => {
  it('should declare a row for every setting the plugin owns', () => {
    const tab = createTab();

    renderRows(tab);

    expect(boundKeys()).toEqual(EXPECTED_PROPERTY_NAMES);
  });

  it('should group the rows under the dependents heading and the three settings headings', () => {
    expect(headings(createTab())).toEqual(EXPECTED_HEADINGS);
  });

  // The overlap banner is the one deliberate exception, and it has to be: Obsidian never calls `display()`
  // Once the declarative definitions are non-empty, so a banner can only reach the tab as a row, and a row
  // Inside a group would read as a setting of that group.
  it('should put every row inside a group, leaving none loose at the top level but the overlap banner', () => {
    const [banner, ...rest] = createTab().getSettingDefinitions();

    expect(banner).not.toHaveProperty('items');
    for (const item of rest) {
      expect(item).toHaveProperty('items');
    }
  });

  it('should lead each settings group with the switch that turns its behavior on', () => {
    const tab = createTab();

    expect(firstRowNamePerGroup(tab)).toEqual([
      'Required by',
      'Should handle renames',
      'Should handle deletions',
      'Treat as attachment extensions'
    ]);
  });

  describe('Plugins that depend on this one', () => {
    it('should be hidden while no enabled plugin depends on this one', () => {
      expect(isVisible(dependentsGroup(createTab()))).toBe(false);
    });

    it('should ignore a plugin that loads without depending on this one', () => {
      announceLoaded({ dependencyPluginIds: ['some-other-plugin'], pluginId: 'unrelated', pluginName: 'Unrelated' });

      expect(isVisible(dependentsGroup(createTab()))).toBe(false);
    });

    it('should show once a dependent has loaded, with one button per dependent in name order', () => {
      announceLoaded({ dependencyPluginIds: [PLUGIN_ID], pluginId: 'zeta', pluginName: 'Zeta' });
      announceLoaded({ dependencyPluginIds: [PLUGIN_ID], pluginId: 'alpha', pluginName: 'Alpha' });
      const tab = createTab();

      expect(isVisible(dependentsGroup(tab))).toBe(true);
      expect(renderDependentsRow(tab).map((button) => button.buttonEl.textContent)).toEqual(['Alpha 1.0.0', 'Zeta 1.0.0']);
    });

    it('should open the dependent\'s own settings tab from its button', () => {
      announceLoaded({ dependencyPluginIds: [PLUGIN_ID], pluginId: 'alpha', pluginName: 'Alpha' });

      const [button] = renderDependentsRow(createTab());
      button?.simulateClick__();

      expect(castTo<SettingLike>(app).setting.openTabById).toHaveBeenCalledWith('alpha');
    });

    it('should drop a dependent once it unloads', () => {
      announceLoaded({ dependencyPluginIds: [PLUGIN_ID], pluginId: 'alpha', pluginName: 'Alpha' });
      app.workspace.trigger(PLUGIN_UNLOADED_EVENT_NAME, createPayload({ dependencyPluginIds: [PLUGIN_ID], pluginId: 'alpha', pluginName: 'Alpha' }));

      expect(isVisible(dependentsGroup(createTab()))).toBe(false);
    });
  });

  // The banner is excluded rather than renamed: a name is what a row shows beside its control, and a bare
  // Host with no control has nothing to put one against.
  it('should give every setting row a name', () => {
    for (const name of settingRowNames(createTab())) {
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

  describe('Consistent Attachments and Links overlap banner', () => {
    it('should hand the row element to the plugin gate, emptied first', () => {
      renderConflictWarningBannerMock.mockImplementation((containerEl) => {
        containerEl.createDiv({ text: 'Overlap' });
      });
      const tab = createTab();
      const setting = new SettingEx(tab.containerEl);
      setting.setName('Leftover');

      bannerRow(tab).render(setting, castTo<SettingGroup>(null));

      expect(renderConflictWarningBannerMock).toHaveBeenCalledWith(setting.settingEl);
      expect(setting.settingEl.textContent).toBe('Overlap');
    });

    // The library renders nothing when no overlap holds, and an empty row is still a row — a divider and a
    // Block of padding with nothing in it.
    it('should hide itself when the gate renders no banner', () => {
      const tab = createTab();
      const setting = new SettingEx(tab.containerEl);

      bannerRow(tab).render(setting, castTo<SettingGroup>(null));

      // `isShown()` reads `offsetParent`, which jsdom never populates, so the display style is what a test
      // Can actually see here.
      expect(setting.settingEl.style.display).toBe('none');
    });

    it('should stay visible once the gate has rendered a banner', () => {
      renderConflictWarningBannerMock.mockImplementation((containerEl) => {
        containerEl.createDiv({ text: 'Overlap' });
      });
      const tab = createTab();
      const setting = new SettingEx(tab.containerEl);

      bannerRow(tab).render(setting, castTo<SettingGroup>(null));

      expect(setting.settingEl.style.display).toBe('');
    });

    // It is not a setting, so it must not surface as one in Obsidian's settings search.
    it('should stay out of the settings search', () => {
      expect(bannerRow(createTab()).searchable).toBe(false);
    });
  });

  it('should expose no setting the plugin does not own', () => {
    const tab = createTab();

    renderRows(tab);

    expect(boundKeys()).toHaveLength(EXPECTED_PROPERTY_NAMES.length);
  });
});

interface PayloadParams {
  readonly dependencyPluginIds: readonly string[];
  readonly pluginId: string;
  readonly pluginName: string;
}

/**
 * Broadcasts a plugin finishing its load, exactly as every `obsidian-dev-utils` plugin does.
 *
 * @param params - The plugin to announce.
 */
function announceLoaded(params: PayloadParams): void {
  app.workspace.trigger(PLUGIN_LOADED_EVENT_NAME, createPayload(params));
}

/**
 * Finds the overlap banner — the one row declared loose at the top level, ahead of every group.
 *
 * @param tab - The settings tab.
 * @returns The row.
 */
function bannerRow(tab: PluginSettingsTab): SettingDefinitionRender {
  const [banner] = tab.getSettingDefinitions();
  if (!banner || 'items' in banner) {
    throw new Error('The overlap banner row is missing.');
  }

  return castTo<SettingDefinitionRender>(banner);
}

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

function createPayload(params: PayloadParams): PluginLifecycleEventPayload {
  return {
    apiVersions: [],
    dependencyPluginIds: params.dependencyPluginIds,
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    pluginVersion: '1.0.0'
  };
}

function createTab(): PluginSettingsTab {
  const plugin = strictProxy<Plugin>({
    app,
    manifest: { id: PLUGIN_ID }
  });
  return new PluginSettingsTab({
    getPluginGateComponent: (): PluginGateComponent =>
      strictProxy<PluginGateComponent>({
        renderConflictWarningBanner: renderConflictWarningBannerMock
      }),
    plugin,
    pluginDependentsComponent,
    pluginSettingsComponent: createMockSettingsComponent()
  });
}

function dependentsGroup(tab: PluginSettingsTab): SettingDefinitionGroup {
  const group = groups(tab).find((candidate) => candidate.heading === DEPENDENTS_HEADING);
  if (!group) {
    throw new Error('The dependents group is missing.');
  }

  return group;
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

function isVisible(group: SettingDefinitionGroup): boolean {
  return typeof group.visible === 'function' ? group.visible() : group.visible ?? true;
}

/**
 * Renders the dependents row and returns the buttons it added, in order.
 *
 * @param tab - The settings tab.
 * @returns The buttons.
 */
function renderDependentsRow(tab: PluginSettingsTab): ButtonComponentMock[] {
  const [row] = flattenRows(castTo<SettingDefinitionItem[]>(dependentsGroup(tab).items ?? []));
  if (!row || !('render' in row)) {
    throw new Error('The dependents row is missing.');
  }

  const setting = new SettingEx(tab.containerEl);
  row.render(setting, castTo<SettingGroup>(null));
  return setting.components.map((component) => castTo<ButtonComponentMock>(component));
}

/**
 * Renders the declared rows the way Obsidian does when the tab is opened: it descends into the groups,
 * skips a group whose `visible` predicate says no, applies the name and description, and runs each row's
 * `render` callback.
 *
 * Only the dependents group declares a predicate, and no row declares `disabled`, so the `disabled` half of
 * Obsidian's renderer is absent — it would be a branch no test can take, against a 100% coverage gate.
 *
 * @param tab - The settings tab.
 */
function renderRows(tab: PluginSettingsTab): void {
  const visibleItems = tab.getSettingDefinitions().filter((item) => !('items' in item) || isVisible(castTo<SettingDefinitionGroup>(item)));
  for (const row of flattenRows(visibleItems)) {
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
 * Reads the names of the rows that are actual SETTINGS — every row inside a group, so the loose overlap
 * banner is left out.
 *
 * @param tab - The settings tab.
 * @returns The names.
 */
function settingRowNames(tab: PluginSettingsTab): string[] {
  return groups(tab).flatMap((group) => flattenRows(castTo<SettingDefinitionItem[]>(group.items ?? []))).map((row) => row.name);
}
