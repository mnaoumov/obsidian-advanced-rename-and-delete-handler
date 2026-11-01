import { evalInObsidian } from 'obsidian-integration-testing';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { PluginSettingsSnapshot } from '../settings/settings-snapshot.integration-helper.ts';

import {
  readPluginSettings,
  writePluginSettings
} from '../settings/settings-snapshot.integration-helper.ts';

/*
 * The two bulk-move members of the published API, `moveMany` and `runInBatch`, reached the way a consumer reaches
 * them: through the `@mnaoumov/obsidian-lib` registry record, not through the plugin instance.
 *
 * Both cases move two notes that link each other into DIFFERENT folders, with a third note linking both and an
 * attachment one of them embeds. Moved one at a time, the first note's link to the second is rewritten against a
 * layout that the second move then changes; that is the case a bulk move exists to get right. Each case asserts what
 * a consumer is promised: by the time the call resolves, every link resolves to the moved file. The links are read
 * through the metadata cache, so the assertion holds whatever link format the vault uses.
 *
 * Cross-platform: the manifest declares `isDesktopOnly: false`, and a plugin may call the API on a phone as well.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';

interface BulkMoveApiLike {
  readonly moveMany: (params: MoveManyParamsLike) => Promise<void>;
  readonly runInBatch: (operation: () => Promise<void>) => Promise<void>;
}

interface BulkMoveInput {
  readonly mode: 'moveMany' | 'runInBatch';
  readonly pluginId: string;
  readonly root: string;
}

interface FileMoveLike {
  readonly newPath: string;
  readonly oldPath: string;
}

interface MoveManyParamsLike {
  readonly moves: readonly FileMoveLike[];
}

interface ObsidianLibStateLike {
  readonly pluginApiRegistry?: PluginApiRegistryWrapperLike;
}

/**
 * The slice of the `@mnaoumov/obsidian-lib` cross-plugin registry a closure reads the API from: the wire-level path
 * that library's Plugin API protocol guide freezes, so a suite reaches the plugin the way a consumer does.
 */
interface PluginApiRegistryHostLike {
  readonly __obsidianLib?: ObsidianLibStateLike;
}

interface PluginApiRegistryLike {
  readonly records?: Partial<Record<string, readonly PublishedPluginApiRecordLike[]>>;
}

interface PluginApiRegistryWrapperLike {
  readonly value?: PluginApiRegistryLike;
}

interface PublishedPluginApiRecordLike {
  readonly api: BulkMoveApiLike;
  readonly isRevoked: boolean;
}

/**
 * Each note's links, as the metadata cache resolves them right after the call resolved: note path to the paths its
 * links resolve to, `null` for one that resolves to nothing.
 */
type ResolvedLinks = Record<string, (null | string)[]>;

/*
 * This plugin's settings outlive each test file — one run drives every suite against one Obsidian instance —
 * so what this suite stages must not become the starting point of whichever file the sequencer runs next.
 * See `settings-snapshot.integration-helper.ts`.
 */
let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

async function cleanUp(root: string): Promise<void> {
  await evalInObsidian({
    async callback({ app, root: rootToDelete }): Promise<void> {
      const folder = app.vault.getFolderByPath(rootToDelete);
      if (folder) {
        await app.fileManager.trashFile(folder);
      }
    },
    input: { root }
  });
}

function expectLinksFollowed(root: string, links: ResolvedLinks, attachmentPath: string): void {
  expect(links).toEqual({
    [`${root}/Alpha/One.md`]: [`${root}/Bravo/Two.md`, attachmentPath],
    [`${root}/Bravo/Two.md`]: [`${root}/Alpha/One.md`],
    [`${root}/Holder.md`]: [`${root}/Alpha/One.md`, `${root}/Bravo/Two.md`]
  });
}

async function runBulkMove(input: BulkMoveInput): Promise<ResolvedLinks> {
  return await evalInObsidian({
    async callback({
      app,
      lib: {
        waitUntil
      },
      mode,
      pluginId,
      root
    }): Promise<ResolvedLinks> {
      /*
       * Under the transport's ~30s per-closure cap, not at it. Two charges: the index wait before the move and the
       * cache wait after it.
       */
      const WAIT_TIMEOUT_IN_MILLISECONDS = 10_000;

      const records = (window as PluginApiRegistryHostLike).__obsidianLib?.pluginApiRegistry?.value?.records?.[pluginId] ?? [];
      const api = records.find((record) => !record.isRevoked)?.api;
      if (!api) {
        throw new Error(`No live API record for ${pluginId}.`);
      }

      const moves: FileMoveLike[] = [
        { newPath: `${root}/Alpha/One.md`, oldPath: `${root}/Source/One.md` },
        { newPath: `${root}/Bravo/Two.md`, oldPath: `${root}/Source/Two.md` },
        { newPath: `${root}/Alpha/One.png`, oldPath: `${root}/Source/One.png` }
      ];

      await app.vault.createFolder(`${root}/Source`);
      await app.vault.createBinary(`${root}/Source/One.png`, new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer);
      await app.vault.create(`${root}/Source/One.md`, '[Two](Two.md)\n\n![](One.png)\n');
      await app.vault.create(`${root}/Source/Two.md`, '[One](One.md)\n');
      await app.vault.create(`${root}/Holder.md`, '[One](Source/One.md) [Two](Source/Two.md)\n');

      const notePaths = [`${root}/Alpha/One.md`, `${root}/Bravo/Two.md`, `${root}/Holder.md`];
      const oldNotePaths = [`${root}/Source/One.md`, `${root}/Source/Two.md`, `${root}/Holder.md`];
      await waitUntil({
        predicate: () => oldNotePaths.every((path) => (app.metadataCache.getCache(path)?.links?.length ?? 0) > 0),
        timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
      });

      if (mode === 'moveMany') {
        await api.moveMany({ moves });
      } else {
        // Unlike `moveMany`, `renameFile` does not create a missing parent folder.
        await app.vault.createFolder(`${root}/Alpha`);
        await app.vault.createFolder(`${root}/Bravo`);
        await api.runInBatch(async () => {
          for (const { newPath, oldPath } of moves.slice(0, 2)) {
            const file = app.vault.getFileByPath(oldPath);
            if (!file) {
              throw new Error(`Missing ${oldPath}.`);
            }
            await app.fileManager.renameFile(file, newPath);
          }
        });
      }

      function resolveLinks(): ResolvedLinks {
        return Object.fromEntries(notePaths.map((path) => {
          const cache = app.metadataCache.getCache(path);
          const references = [...cache?.links ?? [], ...cache?.embeds ?? []];
          return [path, references.map((reference) => app.metadataCache.getFirstLinkpathDest(reference.link.split('#', 1)[0] ?? '', path)?.path ?? null)];
        }));
      }

      // The files are rewritten when the call resolves; the metadata cache re-reads them a moment later.
      await waitUntil({
        predicate: () => Object.values(resolveLinks()).every((targets) => targets.length > 0 && targets.every((target) => target !== null)),
        timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
      }).catch(() => undefined);

      return resolveLinks();
    },
    input: {
      mode: input.mode,
      pluginId: input.pluginId,
      root: input.root
    }
  });
}

describe('the bulk-move API members', () => {
  it('moveMany leaves every link resolving to its moved file once it resolves, with links followed both ways', async () => {
    const root = 'rdh-bulk-move-api-move-many';
    try {
      const links = await runBulkMove({ mode: 'moveMany', pluginId: PLUGIN_ID, root });
      expectLinksFollowed(root, links, `${root}/Alpha/One.png`);
    } finally {
      await cleanUp(root);
    }
  });

  it('runInBatch leaves every link resolving to its renamed file once it resolves', async () => {
    const root = 'rdh-bulk-move-api-run-in-batch';
    await writePluginSettings({ ...originalSettings, shouldHandleRenames: true });
    try {
      const links = await runBulkMove({ mode: 'runInBatch', pluginId: PLUGIN_ID, root });
      // The attachment is not renamed here; `Two.md` is the one whose own link has to follow a LATER rename.
      expectLinksFollowed(root, links, `${root}/Source/One.png`);
    } finally {
      await cleanUp(root);
      await writePluginSettings(originalSettings);
    }
  });
});
