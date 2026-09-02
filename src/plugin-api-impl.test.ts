import type {
  App as AppOriginal,
  PluginManifest
} from 'obsidian';

import { noop } from 'obsidian-dev-utils/function';
import { castTo } from 'obsidian-dev-utils/object-utils';
import { strictProxy } from 'obsidian-dev-utils/strict-proxy';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { PluginSettingsComponent } from './plugin-settings-component.ts';
import type { ShowSettingsMigrationModalParams } from './settings-migration-modal.ts';
import type { SettingsMigrationRow } from './settings-migration.ts';

import { PluginApiImpl } from './plugin-api-impl.ts';
import { PluginSettings } from './plugin-settings.ts';
import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';
import { showSettingsMigrationModal } from './settings-migration-modal.ts';

vi.mock('./settings-migration-modal.ts', () => ({
  showSettingsMigrationModal: vi.fn()
}));

const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

type PluginManifests = Readonly<Record<string, PluginManifest>>;

let settings: PluginSettings;
let editAndSaveCallCount: number;
let pluginSettingsComponent: PluginSettingsComponent;

function createApp(manifests: PluginManifests): AppOriginal {
  /*
   * Plain objects rather than a `strictProxy`: the lookup asks for an id that is deliberately absent —
   * that is the not-installed case — and a strict proxy throws on a missing key instead of answering
   * `undefined` the way the real record does.
   */
  return castTo<AppOriginal>({ plugins: { manifests } });
}

function createPluginApi(app: AppOriginal): PluginApiImpl {
  return new PluginApiImpl({
    app,
    pluginSettingsComponent
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  settings = new PluginSettings();
  editAndSaveCallCount = 0;
  pluginSettingsComponent = strictProxy<PluginSettingsComponent>({
    async editAndSave(settingsEditor: (settingsToEdit: PluginSettings) => Promise<void> | void): Promise<void> {
      editAndSaveCallCount++;
      await settingsEditor(settings);
    },
    settings
  });
});

describe('PluginApiImpl.migrateSettings', () => {
  it('writes what the user approved', async () => {
    vi.mocked(showSettingsMigrationModal).mockImplementation(
      (params: ShowSettingsMigrationModalParams): Promise<null | SettingsMigrationRow[]> => Promise.resolve([...params.rows])
    );

    const result = await createPluginApi(createApp({})).migrateSettings({
      proposedSettings: { shouldHandleDeletions: true },
      sourcePluginId: SOURCE_PLUGIN_ID
    });

    expect(result.isApplied).toBe(true);
    expect(settings.shouldHandleDeletions).toBe(true);
    expect(editAndSaveCallCount).toBe(1);
  });

  it('writes nothing when the user cancels', async () => {
    vi.mocked(showSettingsMigrationModal).mockResolvedValue(null);

    const result = await createPluginApi(createApp({})).migrateSettings({
      proposedSettings: { shouldHandleDeletions: true },
      sourcePluginId: SOURCE_PLUGIN_ID
    });

    expect(result.isApplied).toBe(false);
    expect(settings.shouldHandleDeletions).toBe(false);
    expect(editAndSaveCallCount).toBe(0);
  });

  it('asks nothing when the proposal changes nothing, and still counts as migrated', async () => {
    const result = await createPluginApi(createApp({})).migrateSettings({
      // Both already hold these values, so there is nothing to review.
      proposedSettings: {
        shouldHandleRenames: true,
        treatAsAttachmentExtensions: ['.excalidraw.md']
      },
      sourcePluginId: SOURCE_PLUGIN_ID
    });

    expect(result.isApplied).toBe(true);
    expect(showSettingsMigrationModal).not.toHaveBeenCalled();
    expect(editAndSaveCallCount).toBe(0);
  });

  it('names the proposing plugin by its display name when it is installed', async () => {
    vi.mocked(showSettingsMigrationModal).mockResolvedValue(null);
    const app = createApp({
      [SOURCE_PLUGIN_ID]: castTo<PluginManifest>({ name: 'Custom Attachment Location' })
    });

    await createPluginApi(app).migrateSettings({
      proposedSettings: { shouldHandleDeletions: true },
      sourcePluginId: SOURCE_PLUGIN_ID
    });

    expect(vi.mocked(showSettingsMigrationModal).mock.calls[0]?.[0].sourcePluginName).toBe('Custom Attachment Location');
  });

  it('falls back to the id when the proposing plugin is not installed', async () => {
    vi.mocked(showSettingsMigrationModal).mockResolvedValue(null);

    await createPluginApi(createApp({})).migrateSettings({
      proposedSettings: { shouldHandleDeletions: true },
      sourcePluginId: SOURCE_PLUGIN_ID
    });

    expect(vi.mocked(showSettingsMigrationModal).mock.calls[0]?.[0].sourcePluginName).toBe(SOURCE_PLUGIN_ID);
  });

  it('shows one dialog at a time, so two consumers do not stack modals', async () => {
    const openDialogs: string[] = [];
    let releaseFirstDialog: () => void = noop;
    const firstDialogClosed = new Promise<void>((resolve) => {
      releaseFirstDialog = resolve;
    });

    vi.mocked(showSettingsMigrationModal).mockImplementation(async (params: ShowSettingsMigrationModalParams): Promise<null | SettingsMigrationRow[]> => {
      openDialogs.push(params.sourcePluginName);
      if (openDialogs.length === 1) {
        await firstDialogClosed;
      }
      return null;
    });

    const pluginApi = createPluginApi(createApp({}));
    const firstMigration = pluginApi.migrateSettings({
      proposedSettings: { shouldHandleDeletions: true },
      sourcePluginId: 'first-plugin'
    });
    const secondMigration = pluginApi.migrateSettings({
      proposedSettings: { shouldRenameAttachmentFiles: true },
      sourcePluginId: 'second-plugin'
    });

    await vi.waitFor(() => {
      // The second proposal is still waiting: its dialog has not been opened.
      expect(openDialogs).toEqual(['first-plugin']);
    });

    releaseFirstDialog();
    await Promise.all([firstMigration, secondMigration]);

    expect(openDialogs).toEqual(['first-plugin', 'second-plugin']);
  });
});

describe('PluginApiImpl.getSettings', () => {
  it('hands back what this plugin currently holds', () => {
    expect(createPluginApi(createApp({})).getSettings()).toEqual({
      emptyFolderBehavior: EmptyFolderBehavior.Keep,
      excludePaths: [],
      includePaths: [],
      notePriorities: [],
      shouldDeleteConflictingAttachments: false,
      shouldHandleDeletions: false,
      shouldHandleRenames: true,
      shouldRenameAttachmentFiles: false,
      shouldRenameAttachmentFolder: true,
      shouldRescueSharedAttachments: false,
      shouldUpdateFileNameAliases: true,
      treatAsAttachmentExtensions: ['.excalidraw.md']
    });
  });

  it('reads live, so a consumer that holds the API sees a later edit', () => {
    const pluginApi = createPluginApi(createApp({}));
    expect(pluginApi.getSettings().shouldHandleDeletions).toBe(false);

    settings.shouldHandleDeletions = true;
    settings.notePriorities = ['Index.md'];

    expect(pluginApi.getSettings().shouldHandleDeletions).toBe(true);
    expect(pluginApi.getSettings().notePriorities).toEqual(['Index.md']);
  });

  it('hands back copies of the arrays, so a consumer cannot edit these settings through them', () => {
    settings.excludePaths = ['Archive'];
    const pluginApi = createPluginApi(createApp({}));
    const handedOver = pluginApi.getSettings();

    expect(handedOver.excludePaths).not.toBe(settings.excludePaths);

    castTo<string[]>(handedOver.excludePaths).push('Templates');
    castTo<string[]>(handedOver.treatAsAttachmentExtensions).push('.foo.md');

    expect(settings.excludePaths).toEqual(['Archive']);
    expect(settings.treatAsAttachmentExtensions).toEqual(['.excalidraw.md']);
    expect(pluginApi.getSettings().excludePaths).toEqual(['Archive']);
  });
});

describe('PluginApiImpl.isPathIgnored', () => {
  it('ignores nothing while both lists are empty', () => {
    expect(createPluginApi(createApp({})).isPathIgnored('Notes/Note.md')).toBe(false);
  });

  it('honours an excluded folder', () => {
    settings.excludePaths = ['Archive'];
    const pluginApi = createPluginApi(createApp({}));

    expect(pluginApi.isPathIgnored('Archive/Note.md')).toBe(true);
    expect(pluginApi.isPathIgnored('Notes/Note.md')).toBe(false);
  });

  it('honours an excluded regular expression', () => {
    // An alternation, so this is doing something the plain-path form cannot.
    settings.excludePaths = ['/^(Temp|Scratch)/'];
    const pluginApi = createPluginApi(createApp({}));

    expect(pluginApi.isPathIgnored('Temp/Note.md')).toBe(true);
    expect(pluginApi.isPathIgnored('Scratch/Note.md')).toBe(true);
    expect(pluginApi.isPathIgnored('Notes/Temp/Note.md')).toBe(false);
  });

  it('ignores everything outside the include list', () => {
    settings.includePaths = ['Notes'];
    const pluginApi = createPluginApi(createApp({}));

    expect(pluginApi.isPathIgnored('Notes/Note.md')).toBe(false);
    expect(pluginApi.isPathIgnored('Other/Note.md')).toBe(true);
  });
});

describe('PluginApiImpl.isTreatedAsAttachment', () => {
  it('treats a drawing as an attachment and a plain note as a note', () => {
    const pluginApi = createPluginApi(createApp({}));

    expect(pluginApi.isTreatedAsAttachment('Notes/Drawing.excalidraw.md')).toBe(true);
    expect(pluginApi.isTreatedAsAttachment('Notes/Note.md')).toBe(false);
  });

  it('follows an edited extension list', () => {
    settings.treatAsAttachmentExtensions = ['.canvas.md'];
    const pluginApi = createPluginApi(createApp({}));

    expect(pluginApi.isTreatedAsAttachment('Notes/Board.canvas.md')).toBe(true);
    expect(pluginApi.isTreatedAsAttachment('Notes/Drawing.excalidraw.md')).toBe(false);
  });
});
