import type {
  App as AppOriginal,
  TFolder
} from 'obsidian';
import type { PluginNoticeComponent } from 'obsidian-dev-utils/obsidian/components/plugin-notice-component';
import type { LoopParams } from 'obsidian-dev-utils/obsidian/loop';
import type { CleanupEmptyFoldersParams } from 'obsidian-dev-utils/obsidian/vault';

import { castTo } from 'obsidian-dev-utils/object-utils';
import { loop } from 'obsidian-dev-utils/obsidian/loop';
import { cleanupEmptyFolders } from 'obsidian-dev-utils/obsidian/vault';
import { strictProxy } from 'obsidian-dev-utils/strict-proxy';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { deleteEmptyFolders } from './delete-empty-folders.ts';
import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';

/*
 * `loop` is replaced rather than exercised: it owns a progress notice, a progress bar and animation-frame
 * pacing, none of which this module decides anything about. The stub keeps the one behavior this module
 * DOES depend on — that `processItem` runs once per item, in the order given — so the ordering assertions
 * below still mean what they say.
 */
vi.mock('obsidian-dev-utils/obsidian/loop', () => ({
  loop: vi.fn()
}));

/*
 * Spread over the real module rather than replaced wholesale: `rename-delete-handler-component.ts`
 * re-exports `EmptyFolderBehavior` FROM this module, so a bare factory would leave every enum member
 * below `undefined` and each behavior assertion would pass against nothing.
 */
vi.mock('obsidian-dev-utils/obsidian/vault', async (importOriginal) => ({
  ...await importOriginal<typeof import('obsidian-dev-utils/obsidian/vault')>(),
  cleanupEmptyFolders: vi.fn()
}));

const mockLoop = vi.mocked(loop);
const mockCleanupEmptyFolders = vi.mocked(cleanupEmptyFolders);

const pluginNoticeComponent = strictProxy<PluginNoticeComponent>({});

let getAllFoldersArguments: (boolean | undefined)[] = [];

interface SweepParams {
  readonly emptyFolderBehavior?: EmptyFolderBehavior;
  readonly folderPaths: string[];
  isPathIgnored?(this: void, path: string): boolean;
}

function createApp(folderPaths: string[]): AppOriginal {
  return castTo<AppOriginal>({
    vault: {
      getAllFolders(shouldIncludeRoot?: boolean): TFolder[] {
        getAllFoldersArguments.push(shouldIncludeRoot);
        return folderPaths.map((path) => castTo<TFolder>({ path }));
      }
    }
  });
}

function getCleanupParams(callIndex: number): CleanupEmptyFoldersParams {
  return castTo<CleanupEmptyFoldersParams>(mockCleanupEmptyFolders.mock.calls[callIndex]?.[0]);
}

function getLoopParams(): LoopParams<string> {
  expect(mockLoop).toHaveBeenCalledOnce();
  return castTo<LoopParams<string>>(mockLoop.mock.calls[0]?.[0]);
}

/**
 * Runs the sweep and reports the folder paths it handed to the loop, in order.
 *
 * @param params - The vault's folders, the behavior to apply, and which paths are ignored.
 * @returns The paths the sweep swept.
 */
async function sweep(params: SweepParams): Promise<string[]> {
  await deleteEmptyFolders({
    abortSignal: new AbortController().signal,
    app: createApp(params.folderPaths),
    emptyFolderBehavior: params.emptyFolderBehavior ?? EmptyFolderBehavior.Keep,
    isPathIgnored: params.isPathIgnored ?? ((): boolean => false),
    pluginNoticeComponent
  });

  return getLoopParams().items;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAllFoldersArguments = [];
  mockLoop.mockImplementation(async (params) => {
    for (const item of params.items) {
      await params.processItem(item);
    }
  });
  mockCleanupEmptyFolders.mockResolvedValue(undefined);
});

describe('deleteEmptyFolders', () => {
  it('should sweep every folder deepest first, so a folder holding only empty folders goes in the same pass', async () => {
    const sweptPaths = await sweep({ folderPaths: ['a', 'a/b/c', 'a/b'] });

    expect(sweptPaths).toEqual(['a/b/c', 'a/b', 'a']);
  });

  it('should order folders of equal depth by path, so a run is reproducible', async () => {
    const sweptPaths = await sweep({ folderPaths: ['z', 'a', 'm'] });

    expect(sweptPaths).toEqual(['a', 'm', 'z']);
  });

  it('should never consider the vault root', async () => {
    await sweep({ folderPaths: ['a'] });

    expect(getAllFoldersArguments).toEqual([false]);
  });

  it('should skip a folder the include/exclude lists put out of reach', async () => {
    const sweptPaths = await sweep({
      folderPaths: ['kept', 'Archive/old'],
      isPathIgnored: (path) => path.startsWith('Archive/')
    });

    expect(sweptPaths).toEqual(['kept']);
  });

  it('should sweep even under Keep, because the user asked for this by name', async () => {
    await sweep({
      emptyFolderBehavior: EmptyFolderBehavior.Keep,
      folderPaths: ['empty']
    });

    expect(mockCleanupEmptyFolders).toHaveBeenCalledOnce();
    expect(getCleanupParams(0).emptyFolderBehavior).toBe(EmptyFolderBehavior.Delete);
    expect(getCleanupParams(0).folderPaths).toEqual(['empty']);
  });

  it('should pass Delete through unchanged', async () => {
    await sweep({
      emptyFolderBehavior: EmptyFolderBehavior.Delete,
      folderPaths: ['empty']
    });

    expect(getCleanupParams(0).emptyFolderBehavior).toBe(EmptyFolderBehavior.Delete);
  });

  it('should pass DeleteWithEmptyParents through unchanged, even though a deepest-first pass reaches the parents anyway', async () => {
    await sweep({
      emptyFolderBehavior: EmptyFolderBehavior.DeleteWithEmptyParents,
      folderPaths: ['empty']
    });

    expect(getCleanupParams(0).emptyFolderBehavior).toBe(EmptyFolderBehavior.DeleteWithEmptyParents);
  });

  it('should delete nothing once the sweep is aborted', async () => {
    const abortController = new AbortController();
    abortController.abort();

    await expect(deleteEmptyFolders({
      abortSignal: abortController.signal,
      app: createApp(['empty']),
      emptyFolderBehavior: EmptyFolderBehavior.Delete,
      isPathIgnored: (): boolean => false,
      pluginNoticeComponent
    })).rejects.toThrow();

    expect(mockCleanupEmptyFolders).not.toHaveBeenCalled();
  });

  it('should name the folder it is checking in the progress notice', async () => {
    await sweep({ folderPaths: ['a/b'] });

    expect(
      getLoopParams().buildNoticeMessage({
        item: 'a/b',
        iterationString: '# 1 / 1'
      })
    ).toBe('Checking folder # 1 / 1 - a/b');
  });
});
