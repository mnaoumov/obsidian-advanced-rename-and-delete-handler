import type {
  App,
  PluginManifest
} from 'obsidian';
import type {
  PluginConflict,
  PluginGateComponent
} from 'obsidian-dev-utils/obsidian/components/plugin-gate-component';
import type { PluginApiDeclaration } from 'obsidian-dev-utils/obsidian/plugin/plugin-api';

import { castTo } from 'obsidian-dev-utils/object-utils';
import { PluginConflictSeverity } from 'obsidian-dev-utils/obsidian/components/plugin-gate-component';
import { PluginSettingsTabComponent } from 'obsidian-dev-utils/obsidian/components/plugin-settings-tab-component';
import { watchPluginApi } from 'obsidian-dev-utils/obsidian/plugin/plugin-api';
import { ensureNonNullable } from 'obsidian-dev-utils/type-guards';
import { App as AppCls } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { InstalledConflict } from './conflicting-plugins.ts';
import type { RenameDeleteHandlerSettings } from './rename-delete-handler-component.ts';

interface ComponentModuleActual {
  Component: new () => object;
}

interface FileManagerLike {
  runAsyncLinkUpdate: ReturnType<typeof vi.fn>;
}

interface FileManagerWithLinkUpdate {
  fileManager: FileManagerLike;
}

// `getPluginApis` is protected on the base for the same reason.
interface PluginApisProbe {
  getPluginApis(): PluginApiDeclaration[];
}

// `getPluginConflicts` is protected on the base — the declaration is for the library, not for callers —
// So a test reads it through a probe rather than widening the plugin's own surface.
interface PluginConflictsProbe {
  getPluginConflicts(): PluginConflict[];
}

interface PluginGateProbe {
  readonly pluginGateComponent: PluginGateComponent;
}

interface PluginsLike {
  disablePlugin: ReturnType<typeof vi.fn>;
}

interface RenameDeleteHandlerComponentParams {
  settingsBuilder(): Partial<RenameDeleteHandlerSettings>;
}

interface SettingsTabParamsProbe {
  getPluginGateComponent(): PluginGateComponent;
}

const {
  mockFindInstalledConflicts,
  renameDeleteHandlerStub
} = vi.hoisted(() => ({
  mockFindInstalledConflicts: vi.fn(),
  renameDeleteHandlerStub: vi.fn<(params: RenameDeleteHandlerComponentParams) => object>()
}));

// Stub the plugin's OWN sibling modules. The settings stub extends the real test-mocks `Component` so the
// Real `PluginBase` lifecycle can load it as a child without the heavy settings-base dependencies.
vi.mock('./plugin-settings-component.ts', async () => {
  const { Component } = await vi.importActual<ComponentModuleActual>('obsidian');
  const { PluginSettings } = await vi.importActual<typeof import('./plugin-settings.ts')>('./plugin-settings.ts');
  const { noopAsync } = await vi.importActual<typeof import('obsidian-dev-utils/function')>('obsidian-dev-utils/function');
  class PluginSettingsComponent extends Component {
    public settings = new PluginSettings();

    // A `data.json` is present, so the first-load notice stays quiet; its own suite covers the other case.
    public wasDataFileMissingOnInitialLoad = false;

    public editAndSave(editor: (settings: unknown) => unknown): Promise<void> {
      return Promise.resolve(editor(this.settings)).then(() => undefined);
    }

    public isNoteEx(path: string): boolean {
      return path.endsWith('.md');
    }

    public whenLoadedFromFile(): Promise<void> {
      return noopAsync();
    }
  }
  return { PluginSettingsComponent };
});

vi.mock('./plugin-settings-tab.ts', () => ({
  PluginSettingsTab: vi.fn()
}));

vi.mock('./conflicting-plugins.ts', () => ({
  findInstalledConflicts: mockFindInstalledConflicts
}));

vi.mock('./rename-delete-handler-component.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rename-delete-handler-component.ts')>();
  const { Component } = await vi.importActual<ComponentModuleActual>('obsidian');
  // eslint-disable-next-line prefer-arrow-callback -- a vi.fn used with `new` must be a non-arrow function returning a fresh real Component.
  renameDeleteHandlerStub.mockImplementation(function NamedStub() {
    return new Component();
  });
  return {
    ...actual,
    RenameDeleteHandlerComponent: renameDeleteHandlerStub
  };
});

// eslint-disable-next-line import-x/first, import-x/imports-first -- vi.mock must precede imports.
import { FirstLoadNoticeComponent } from './first-load-notice-component.ts';
// eslint-disable-next-line import-x/first, import-x/imports-first -- vi.mock must precede imports.
import { PLUGIN_API_VERSION } from './plugin-api.ts';
// eslint-disable-next-line import-x/first, import-x/imports-first -- vi.mock must precede imports.
import { PluginDependentsComponent } from './plugin-dependents-component.ts';
// eslint-disable-next-line import-x/first, import-x/imports-first -- vi.mock must precede imports.
import { PluginSettingsComponent } from './plugin-settings-component.ts';
// eslint-disable-next-line import-x/first, import-x/imports-first -- vi.mock must precede imports.
import { PluginSettingsTab } from './plugin-settings-tab.ts';
// eslint-disable-next-line import-x/first, import-x/imports-first -- vi.mock must precede imports.
import { Plugin } from './plugin.ts';
// eslint-disable-next-line import-x/first, import-x/imports-first -- vi.mock must precede imports.
import { RescueDecisionScope } from './rescue-decision-scope.ts';

const PLUGIN_MANIFEST: PluginManifest = {
  author: 'test',
  description: 'test',
  id: 'advanced-rename-and-delete-handler',
  minAppVersion: '1.0.0',
  name: 'Advanced Rename and Delete Handler',
  version: '1.0.0'
};

const CONFLICT: InstalledConflict = {
  installedVersion: '11.10.0',
  plugin: {
    minSupportedVersion: '12.0.0',
    name: 'Custom Attachment Location',
    pluginId: 'obsidian-custom-attachment-location'
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindInstalledConflicts.mockReturnValue([]);
});

function createConfiguredApp(): App {
  const appMock = AppCls.createConfigured__();
  appMock.workspace.onLayoutReady = vi.fn((callback: () => void) => {
    callback();
  });
  // `disablePlugin` is the one member of the registry obsidian-test-mocks does not model - it covers the
  // Honest core and leaves the enable/disable lifecycle to throw - so it is seeded on the real registry
  // Rather than replacing it. `getPlugin` needs nothing: the mock already answers `null`.
  castTo<PluginsLike>(appMock.plugins).disablePlugin = vi.fn().mockResolvedValue(undefined);
  const app = appMock.asOriginalType__();
  castTo<FileManagerWithLinkUpdate>(app).fileManager.runAsyncLinkUpdate = vi.fn();
  return app;
}

describe('Plugin', () => {
  describe('with no conflicting plugin installed', () => {
    it('should add its own settings component and settings tab', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      const addChildSpy = vi.spyOn(plugin, 'addChild');

      await plugin.onload();

      const addedChildren = addChildSpy.mock.calls.map((call) => call[0]);
      expect(addedChildren.some((child) => child instanceof PluginSettingsComponent)).toBe(true);
      expect(addedChildren.some((child) => child instanceof PluginSettingsTabComponent)).toBe(true);
      plugin.unload();
    });

    it('should expose its API once it has loaded', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);

      // Nothing to call before the plugin has loaded — and nothing published either.
      expect(plugin.api).toBeNull();

      await plugin.onload();

      expect(plugin.api).not.toBeNull();
      plugin.unload();
    });

    // Declared rather than published by hand, so the base revokes it with the feature surface and names its
    // Contract version in the `plugin-loaded` broadcast a dependent's gate listens for.
    it('should declare its API for the base to publish', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      await plugin.onload();

      const declarations = castTo<PluginApisProbe>(plugin).getPluginApis();

      expect(declarations).toHaveLength(1);
      expect(declarations[0]?.api).toBe(plugin.api);
      expect(declarations[0]?.apiVersion).toBe(PLUGIN_API_VERSION);
      plugin.unload();
    });

    it('should publish its API where a dependent\'s watch can see it', async () => {
      const app = createConfiguredApp();
      const plugin = new Plugin(app, PLUGIN_MANIFEST);
      await plugin.onload();

      const apiRef = watchPluginApi<object>({
        apiVersionRange: '^1.1.0',
        app,
        component: plugin,
        pluginId: PLUGIN_MANIFEST.id
      });

      expect(apiRef.value).not.toBeNull();
      plugin.unload();
    });

    it('should add the first-load notice and the dependents tracker', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      const addChildSpy = vi.spyOn(plugin, 'addChild');

      await plugin.onload();

      const addedChildren = addChildSpy.mock.calls.map((call) => call[0]);
      expect(addedChildren.some((child) => child instanceof FirstLoadNoticeComponent)).toBe(true);
      expect(addedChildren.some((child) => child instanceof PluginDependentsComponent)).toBe(true);
      plugin.unload();
    });

    it('should construct the rename/delete handler', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);

      await plugin.onload();

      expect(renameDeleteHandlerStub).toHaveBeenCalledOnce();
      plugin.unload();
    });

    it('should build the handler settings entirely from this plugin\'s own settings', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);

      await plugin.onload();

      const params = ensureNonNullable(renameDeleteHandlerStub.mock.calls[0])[0];
      const builtSettings = params.settingsBuilder();
      expect(builtSettings.shouldHandleRenames).toBe(false);
      expect(builtSettings.shouldUpdateFileNameAliases).toBe(true);
      expect(builtSettings.shouldRenameAttachmentFolder).toBe(false);
      expect(builtSettings.shouldHandleDeletions).toBe(false);
      expect(builtSettings.shouldDeleteConflictingAttachments).toBe(false);
      plugin.unload();
    });

    it('should route isNote through the settings component', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);

      await plugin.onload();

      const params = ensureNonNullable(renameDeleteHandlerStub.mock.calls[0])[0];
      expect(params.settingsBuilder().isNote?.('note.md')).toBe(true);
      expect(params.settingsBuilder().isNote?.('image.png')).toBe(false);
      plugin.unload();
    });

    it('should route isPathIgnored and getRescuePath through this plugin\'s own pieces', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);

      await plugin.onload();

      const params = ensureNonNullable(renameDeleteHandlerStub.mock.calls[0])[0];
      const builtSettings = params.settingsBuilder();
      expect(builtSettings.isPathIgnored?.('anything.md')).toBe(false);
      await expect(
        builtSettings.getRescuePath?.({
          attachmentPath: 'attachments/image.png',
          rescueDecisionScope: new RescueDecisionScope(),
          survivingNotePaths: ['keeper.md']
        })
      ).resolves.toBeNull();
      plugin.unload();
    });

    it('should register the open demo vault command', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      const addCommandSpy = vi.spyOn(plugin, 'addCommand');

      await plugin.onload();

      expect(addCommandSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'open-demo-vault' }));
      plugin.unload();
    });

    it('should register the delete empty folders command', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      const addCommandSpy = vi.spyOn(plugin, 'addCommand');

      await plugin.onload();

      expect(addCommandSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'delete-empty-folders' }));
      plugin.unload();
    });

    it('should not disable itself', async () => {
      const app = createConfiguredApp();
      const plugin = new Plugin(app, PLUGIN_MANIFEST);

      await plugin.onload();

      expect(castTo<PluginsLike>(app.plugins).disablePlugin).not.toHaveBeenCalled();
      plugin.unload();
    });

    it('should declare the Delete empty folders overlap as a warning rather than a refusal to run', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      await plugin.onload();

      const conflicts = castTo<PluginConflictsProbe>(plugin).getPluginConflicts();

      expect(conflicts).toHaveLength(1);
      const [conflict] = conflicts;
      expect(conflict?.pluginId).toBe('consistent-attachments-and-links');
      expect(conflict?.pluginName).toBe('Consistent Attachments and Links');
      // A duplicated palette entry is annoying, not vault-corrupting, so both plugins keep running —
      // Unlike the rename/delete overlap, which this plugin refuses outright.
      expect(conflict?.severity).toBe(PluginConflictSeverity.Warn);
      // Bounded BELOW as well: under 4.0.0 that plugin still owns a rename/delete handler, and the
      // Refusal above already owns that message.
      expect(conflict?.conflictingVersionRange).toBe('>=4.0.0 <5.0.0');
      expect(conflict?.reason).toContain('Delete empty folders');
      plugin.unload();
    });

    // The settings tab takes an ACCESSOR rather than the gate itself: the gate is what loads the feature
    // Surface, so at the moment `onloadImpl` builds the tab the base has not assigned it yet, and reading
    // It eagerly throws.
    it('should hand the settings tab a lazy route to the plugin gate', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      await plugin.onload();

      const call = vi.mocked(PluginSettingsTab).mock.calls[0];
      if (!call) {
        throw new Error('PluginSettingsTab was not constructed.');
      }

      const params = castTo<SettingsTabParamsProbe>(call[0]);
      expect(params.getPluginGateComponent()).toBe(castTo<PluginGateProbe>(plugin).pluginGateComponent);
      plugin.unload();
    });
  });

  describe('with a conflicting plugin installed', () => {
    beforeEach(() => {
      mockFindInstalledConflicts.mockReturnValue([CONFLICT]);
    });

    it('should disable itself', async () => {
      const app = createConfiguredApp();
      const plugin = new Plugin(app, PLUGIN_MANIFEST);

      await plugin.onload();

      expect(castTo<PluginsLike>(app.plugins).disablePlugin).toHaveBeenCalledWith(PLUGIN_MANIFEST.id);
      plugin.unload();
    });

    it('should register no rename/delete handler', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);

      await plugin.onload();

      expect(renameDeleteHandlerStub).not.toHaveBeenCalled();
      plugin.unload();
    });

    it('should declare no API', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);

      await plugin.onload();

      expect(castTo<PluginApisProbe>(plugin).getPluginApis()).toEqual([]);
      plugin.unload();
    });

    it('should add no settings tab', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      const addChildSpy = vi.spyOn(plugin, 'addChild');

      await plugin.onload();

      const addedChildren = addChildSpy.mock.calls.map((call) => call[0]);
      expect(addedChildren.some((child) => child instanceof PluginSettingsTabComponent)).toBe(false);
      plugin.unload();
    });
  });
});
