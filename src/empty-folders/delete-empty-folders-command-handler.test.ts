import type { PluginNoticeComponent } from '@mnaoumov/obsidian-lib/components/plugin-notice-component';
import type { App as AppOriginal } from 'obsidian';

import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { strictProxy } from '@mnaoumov/typescript-test-toolkit/strict-proxy';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { PluginSettingsComponent } from '../settings/plugin-settings-component.ts';
import type { DeleteEmptyFoldersParams } from './delete-empty-folders.ts';

import { EmptyFolderBehavior } from '../rename-delete-handler/rename-delete-handler-component.ts';
import { PluginSettings } from '../settings/plugin-settings.ts';
import { DeleteEmptyFoldersCommandHandler } from './delete-empty-folders-command-handler.ts';
import { deleteEmptyFolders } from './delete-empty-folders.ts';

vi.mock('./delete-empty-folders.ts', () => ({
  deleteEmptyFolders: vi.fn()
}));

const mockDeleteEmptyFolders = vi.mocked(deleteEmptyFolders);

interface CommandHandlerPrivate {
  readonly execute: () => Promise<void>;
}

function asPrivate(handler: DeleteEmptyFoldersCommandHandler): CommandHandlerPrivate {
  return castTo<CommandHandlerPrivate>(handler);
}

const abortSignal = new AbortController().signal;
const app = castTo<AppOriginal>({});
const pluginNoticeComponent = strictProxy<PluginNoticeComponent>({});

let settings: PluginSettings;
let handler: DeleteEmptyFoldersCommandHandler;

function getSweepParams(): DeleteEmptyFoldersParams {
  return castTo<DeleteEmptyFoldersParams>(mockDeleteEmptyFolders.mock.calls[0]?.[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteEmptyFolders.mockResolvedValue(undefined);
  settings = new PluginSettings();
  handler = new DeleteEmptyFoldersCommandHandler({
    abortSignal,
    app,
    pluginNoticeComponent,
    pluginSettingsComponent: strictProxy<PluginSettingsComponent>({
      get settings(): PluginSettings {
        return settings;
      }
    })
  });
});

describe('DeleteEmptyFoldersCommandHandler', () => {
  it('should keep the id, name and icon the command had in its previous home, so an existing hotkey still works', () => {
    const command = handler.buildCommand();

    expect(command.id).toBe('delete-empty-folders');
    expect(command.name).toBe('Delete empty folders');
    expect(command.icon).toBe('trash');
  });

  it('should sweep the vault on execute', async () => {
    await asPrivate(handler).execute();

    expect(mockDeleteEmptyFolders).toHaveBeenCalledOnce();
    expect(getSweepParams().app).toBe(app);
    expect(getSweepParams().abortSignal).toBe(abortSignal);
    expect(getSweepParams().pluginNoticeComponent).toBe(pluginNoticeComponent);
  });

  it('should read the settings at invocation time, not at construction', async () => {
    settings.emptyFolderBehavior = EmptyFolderBehavior.DeleteWithEmptyParents;

    await asPrivate(handler).execute();

    expect(getSweepParams().emptyFolderBehavior).toBe(EmptyFolderBehavior.DeleteWithEmptyParents);
  });

  it('should route the ignore check through the plugin\'s own include/exclude lists', async () => {
    settings.excludePaths = ['Archive'];

    await asPrivate(handler).execute();

    expect(getSweepParams().isPathIgnored('Archive', true)).toBe(true);
    expect(getSweepParams().isPathIgnored('Notes', true)).toBe(false);
  });

  it('should pass the folder flag through, so a folder-only glob matches the folder itself', async () => {
    settings.excludePaths = ['tmp*/'];

    await asPrivate(handler).execute();

    expect(getSweepParams().isPathIgnored('tmp-old', true)).toBe(true);
    expect(getSweepParams().isPathIgnored('tmp-old', false)).toBe(false);
  });
});
