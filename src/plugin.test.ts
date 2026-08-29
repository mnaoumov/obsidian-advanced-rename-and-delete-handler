import type {
  App,
  PluginManifest
} from 'obsidian';

import { castTo } from 'obsidian-dev-utils/object-utils';
import { PluginSettingsTabComponent } from 'obsidian-dev-utils/obsidian/components/plugin-settings-tab-component';
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

interface PluginsLike {
  disablePlugin: ReturnType<typeof vi.fn>;
  getPlugin: ReturnType<typeof vi.fn>;
}

interface PluginsMock {
  plugins: PluginsLike;
}

interface RenameDeleteHandlerComponentParams {
  settingsBuilder(): Partial<RenameDeleteHandlerSettings>;
}

const {
  initialSettingsOverrides,
  mockFindInstalledConflicts,
  mockMigrateLegacySettings,
  renameDeleteHandlerStub
} = vi.hoisted(() => ({
  initialSettingsOverrides: { hasMigratedLegacySettings: false },
  mockFindInstalledConflicts: vi.fn(),
  mockMigrateLegacySettings: vi.fn(),
  renameDeleteHandlerStub: vi.fn<(params: RenameDeleteHandlerComponentParams) => object>()
}));

// Stub the plugin's OWN sibling modules. The settings stub extends the real test-mocks `Component` so the
// Real `PluginBase` lifecycle can load it as a child without the heavy settings-base dependencies.
vi.mock('./plugin-settings-component.ts', async () => {
  const { Component } = await vi.importActual<ComponentModuleActual>('obsidian');
  const { PluginSettings } = await vi.importActual<typeof import('./plugin-settings.ts')>('./plugin-settings.ts');
  class PluginSettingsComponent extends Component {
    public settings = Object.assign(new PluginSettings(), initialSettingsOverrides);

    public editAndSave(editor: (settings: unknown) => unknown): Promise<void> {
      return Promise.resolve(editor(this.settings)).then(() => undefined);
    }

    public isNoteEx(path: string): boolean {
      return path.endsWith('.md');
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

vi.mock('./legacy-settings-migrator.ts', () => ({
  migrateLegacySettings: mockMigrateLegacySettings
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
import { PluginSettingsComponent } from './plugin-settings-component.ts';
// eslint-disable-next-line import-x/first, import-x/imports-first -- vi.mock must precede imports.
import { Plugin } from './plugin.ts';

const PLUGIN_MANIFEST: PluginManifest = {
  author: 'test',
  description: 'test',
  id: 'advanced-rename-delete-handler',
  minAppVersion: '1.0.0',
  name: 'Advanced Rename/Delete Handler',
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
  initialSettingsOverrides.hasMigratedLegacySettings = false;
  mockFindInstalledConflicts.mockReturnValue([]);
  mockMigrateLegacySettings.mockResolvedValue({ importedFromPluginIds: [] });
});

function createConfiguredApp(): App {
  const appMock = AppCls.createConfigured__();
  appMock.workspace.onLayoutReady = vi.fn((callback: () => void) => {
    callback();
  });
  // The strict App mock throws on an unmocked member, so `plugins` is assigned wholesale before use.
  castTo<PluginsMock>(appMock).plugins = {
    disablePlugin: vi.fn().mockResolvedValue(undefined),
    getPlugin: vi.fn().mockReturnValue(null)
  };
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
      expect(builtSettings.shouldHandleRenames).toBe(true);
      expect(builtSettings.shouldUpdateFileNameAliases).toBe(true);
      expect(builtSettings.shouldRenameAttachmentFolder).toBe(true);
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

    it('should not disable itself', async () => {
      const app = createConfiguredApp();
      const plugin = new Plugin(app, PLUGIN_MANIFEST);

      await plugin.onload();

      expect(castTo<PluginsMock>(app).plugins.disablePlugin).not.toHaveBeenCalled();
      plugin.unload();
    });
  });

  describe('legacy settings migration', () => {
    it('should migrate once and record that it did', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      const addChildSpy = vi.spyOn(plugin, 'addChild');

      await plugin.onload();

      expect(mockMigrateLegacySettings).toHaveBeenCalledOnce();
      const settingsComponent = castTo<PluginSettingsComponent>(
        addChildSpy.mock.calls.map((call) => call[0]).find((child) => child instanceof PluginSettingsComponent)
      );
      expect(settingsComponent.settings.hasMigratedLegacySettings).toBe(true);
      plugin.unload();
    });

    it('should not migrate again once it already has', async () => {
      initialSettingsOverrides.hasMigratedLegacySettings = true;
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);

      await plugin.onload();

      expect(mockMigrateLegacySettings).not.toHaveBeenCalled();
      plugin.unload();
    });

    it('should report which plugins it imported from', async () => {
      mockMigrateLegacySettings.mockResolvedValue({ importedFromPluginIds: ['obsidian-custom-attachment-location'] });
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);

      await plugin.onload();

      expect(mockMigrateLegacySettings).toHaveBeenCalledOnce();
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

      expect(castTo<PluginsMock>(app).plugins.disablePlugin).toHaveBeenCalledWith(PLUGIN_MANIFEST.id);
      plugin.unload();
    });

    it('should register no rename/delete handler', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);

      await plugin.onload();

      expect(renameDeleteHandlerStub).not.toHaveBeenCalled();
      plugin.unload();
    });

    it('should not migrate settings it is not going to use', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);

      await plugin.onload();

      expect(mockMigrateLegacySettings).not.toHaveBeenCalled();
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
