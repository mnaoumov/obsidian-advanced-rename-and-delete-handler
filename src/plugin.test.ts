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

import type { RenameDeleteHandlerSettings } from './rename-delete-handler-component.ts';

interface AppWithSetting {
  setting: SettingLike;
}

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
  getPluginApis: () => PluginApiDeclaration[];
}

// `getPluginConflicts` is protected on the base — the declaration is for the library, not for callers —
// so a test reads it through a probe rather than widening the plugin's own surface.
interface PluginConflictsProbe {
  getPluginConflicts: () => PluginConflict[];
}

interface PluginGateProbe {
  readonly pluginGateComponent: PluginGateComponent;
}

interface PluginsLike {
  disablePlugin: ReturnType<typeof vi.fn>;
  manifests: Record<string, PluginManifest>;
}

interface RenameDeleteHandlerComponentParams {
  readonly settingsBuilder: () => Partial<RenameDeleteHandlerSettings>;
}

interface SettingLike {
  addSettingTab: ReturnType<typeof vi.fn>;
  removeSettingTab: ReturnType<typeof vi.fn>;
}

interface SettingsTabParamsProbe {
  getPluginGateComponent: () => PluginGateComponent;
}

const { renameDeleteHandlerStub } = vi.hoisted(() => ({
  renameDeleteHandlerStub: vi.fn<(params: RenameDeleteHandlerComponentParams) => object>()
}));

// Stub the plugin's OWN sibling modules. The settings stub extends the real test-mocks `Component` so the
// real `PluginBase` lifecycle can load it as a child without the heavy settings-base dependencies.
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
import { PluginApiImpl } from './plugin-api-impl.ts';
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

const CONFLICTING_PLUGIN_ID = 'obsidian-custom-attachment-location';
const CONFLICTING_PLUGIN_NAME = 'Custom Attachment Location';
const CONFLICTING_PLUGIN_VERSION = '11.10.0';

beforeEach(() => {
  vi.clearAllMocks();
});

function createConfiguredApp(): App {
  const appMock = AppCls.createConfigured__();
  appMock.workspace.onLayoutReady = vi.fn((callback: () => void) => {
    callback();
  });
  // `disablePlugin` is the one member of the registry obsidian-test-mocks does not model - it covers the
  // honest core and leaves the enable/disable lifecycle to throw - so it is seeded on the real registry
  // rather than replacing it. `getPlugin` needs nothing: the mock already answers `null`.
  castTo<PluginsLike>(appMock.plugins).disablePlugin = vi.fn().mockResolvedValue(undefined);
  const app = appMock.asOriginalType__();
  castTo<FileManagerWithLinkUpdate>(app).fileManager.runAsyncLinkUpdate = vi.fn();
  return app;
}

/**
 * Installs a plugin that still owns a rename/delete handler, at a version the block covers.
 *
 * The gate reads the MANIFEST rather than the registry — a plugin that has not loaded yet has registered
 * nothing — so this is the whole of what it takes to make a declared conflict active, and it is the real
 * gate that is exercised rather than a seam standing in for it.
 *
 * `manifests` and `setting` are seeded the same way `disablePlugin` is, and for the same reason:
 * obsidian-test-mocks does not model either of them, and a strict proxy throws on the read until something
 * has been assigned. `setting` is reached only on this path — the library registers a BLOCKED settings tab in place
 * of the one this plugin never got to add.
 *
 * @param app - The app to install into.
 */
function installConflictingPlugin(app: App): void {
  castTo<AppWithSetting>(app).setting = {
    addSettingTab: vi.fn(),
    removeSettingTab: vi.fn()
  };
  castTo<PluginsLike>(app.plugins).manifests = {
    [CONFLICTING_PLUGIN_ID]: {
      author: 'test',
      description: 'test',
      id: CONFLICTING_PLUGIN_ID,
      minAppVersion: '1.0.0',
      name: CONFLICTING_PLUGIN_NAME,
      version: CONFLICTING_PLUGIN_VERSION
    }
  };
  app.plugins.enabledPlugins.add(CONFLICTING_PLUGIN_ID);
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

    it('should declare no API until it has loaded', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);

      // Nothing to call before the plugin has loaded — and nothing published either.
      expect(castTo<PluginApisProbe>(plugin).getPluginApis()).toEqual([]);

      await plugin.onload();

      expect(castTo<PluginApisProbe>(plugin).getPluginApis()).toHaveLength(1);
      plugin.unload();
    });

    // The registry is the only route: an instance member would hand a consumer whatever version is installed,
    // with no negotiation, no contract check and no revocation.
    it('should not expose its API on the plugin instance', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      await plugin.onload();

      expect('api' in plugin).toBe(false);
      plugin.unload();
    });

    // Declared rather than published by hand, so the base revokes it with the feature surface and names its
    // contract version in the `plugin-loaded` broadcast a dependent's gate listens for.
    it('should declare its API for the base to publish', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      await plugin.onload();

      const declarations = castTo<PluginApisProbe>(plugin).getPluginApis();

      expect(declarations).toHaveLength(1);
      expect(declarations[0]?.api).toBeInstanceOf(PluginApiImpl);
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

    it('should block every plugin that still owns a rename/delete handler', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      await plugin.onload();

      const blocking = castTo<PluginConflictsProbe>(plugin).getPluginConflicts()
        .filter((conflict) => conflict.severity === PluginConflictSeverity.Block);

      // Ranges rather than minimums, so an entry says which versions conflict rather than which do not.
      expect(blocking.map((conflict) => [conflict.pluginId, conflict.conflictingVersionRange])).toEqual([
        [CONFLICTING_PLUGIN_ID, '<12.0.0'],
        ['consistent-attachments-and-links', '<4.0.0'],
        ['better-markdown-links', '<5.0.0'],
        ['external-rename-handler', '<4.0.0'],
        ['frontmatter-markdown-links', '<3.0.0']
      ]);
      plugin.unload();
    });

    /*
     * The requirement Custom Attachment Location's issue 79 handed over: two reporters read the notice this
     * block replaced as a defect in THIS plugin. Every version these entries ask for has shipped, so a
     * blocked user is waiting rather than stuck — and the reason has to read that way, name the other plugin
     * as the one to update, and say that recovery costs nothing.
     */
    it('should word each block as a wait on the other plugin\'s update', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      await plugin.onload();

      const blocking = castTo<PluginConflictsProbe>(plugin).getPluginConflicts()
        .filter((conflict) => conflict.severity === PluginConflictSeverity.Block);

      for (const conflict of blocking) {
        expect(conflict.reason).toContain(`waiting for ${conflict.pluginName}`);
        expect(conflict.reason).toContain('Update it');
        expect(conflict.reason).toContain('no restart');
        expect(conflict.reason).not.toContain('Not running');
      }
      plugin.unload();
    });

    it('should declare the Delete empty folders overlap as a warning rather than a block', async () => {
      const plugin = new Plugin(createConfiguredApp(), PLUGIN_MANIFEST);
      await plugin.onload();

      const warnings = castTo<PluginConflictsProbe>(plugin).getPluginConflicts()
        .filter((conflict) => conflict.severity === PluginConflictSeverity.Warn);

      expect(warnings).toHaveLength(1);
      const [conflict] = warnings;
      expect(conflict?.pluginId).toBe('consistent-attachments-and-links');
      expect(conflict?.pluginName).toBe('Consistent Attachments and Links');
      // Bounded BELOW as well: under 4.0.0 that plugin still owns a rename/delete handler, and the BLOCK
      // declared for the same id already owns that message.
      expect(conflict?.conflictingVersionRange).toBe('>=4.0.0 <5.0.0');
      expect(conflict?.reason).toContain('Delete empty folders');
      plugin.unload();
    });

    // The settings tab takes an ACCESSOR rather than the gate itself: the gate is what loads the feature
    // surface, so at the moment `onloadImpl` builds the tab the base has not assigned it yet, and reading
    // it eagerly throws.
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
    /*
     * Enabled-but-inert, NOT self-disabled — the one behaviour the move to the shared gate deliberately
     * changed. The guard this replaced called `disablePlugin` on itself, which took the plugin out of the
     * running list until the next Obsidian start; the gate leaves it in the user's enabled list with its
     * feature surface shut, so it resumes the moment the conflict lifts.
     */
    it('should stay enabled rather than disabling itself', async () => {
      const app = createConfiguredApp();
      installConflictingPlugin(app);
      const plugin = new Plugin(app, PLUGIN_MANIFEST);

      await plugin.onload();

      expect(castTo<PluginsLike>(app.plugins).disablePlugin).not.toHaveBeenCalled();
      plugin.unload();
    });

    it('should register no rename/delete handler', async () => {
      const app = createConfiguredApp();
      installConflictingPlugin(app);
      const plugin = new Plugin(app, PLUGIN_MANIFEST);

      await plugin.onload();

      expect(renameDeleteHandlerStub).not.toHaveBeenCalled();
      plugin.unload();
    });

    it('should declare no API', async () => {
      const app = createConfiguredApp();
      installConflictingPlugin(app);
      const plugin = new Plugin(app, PLUGIN_MANIFEST);

      await plugin.onload();

      expect(castTo<PluginApisProbe>(plugin).getPluginApis()).toEqual([]);
      plugin.unload();
    });

    // Its own, that is. The library registers a BLOCKED tab in its place, carrying the reason and the two
    // ways out of it, so the user still finds an explanation where they look for the settings.
    it('should add no settings tab of its own', async () => {
      const app = createConfiguredApp();
      installConflictingPlugin(app);
      const plugin = new Plugin(app, PLUGIN_MANIFEST);
      const addChildSpy = vi.spyOn(plugin, 'addChild');

      await plugin.onload();

      const addedChildren = addChildSpy.mock.calls.map((call) => call[0]);
      expect(addedChildren.some((child) => child instanceof PluginSettingsTabComponent)).toBe(false);
      plugin.unload();
    });
  });
});
