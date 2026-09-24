import type { MetadataCache } from 'obsidian';

import {
  ContextId,
  evalInObsidian,
  pollInObsidian
} from 'obsidian-integration-testing';
import { getTemporaryVault } from 'obsidian-integration-testing/vitest-global-setup-plugin';
import {
  describe,
  expect,
  it
} from 'vitest';

import {
  PLUGIN_ID,
  RENAME_WALK_HOLDER_COUNT,
  RENAME_WALK_HOLDERS_FOLDER,
  RENAME_WALK_MOVED_FOLDER,
  RENAME_WALK_MOVED_NOTE_COUNT
} from '../scripts/generate-performance-vault.ts';

/*
 * Guards the fix for the handler walking the whole vault twice per renamed file.
 *
 * Obsidian's `metadataCache.getBacklinksForFile` is a full `iterateAllRefs` walk with a `getFirstLinkpathDest`
 * per reference, not an index lookup. The handler used to call it twice per renamed file — once synchronously
 * inside the vault `rename` event, once from the queued `refreshLinks` — so renaming a folder of F notes walked
 * the vault 2F + 1 times, the one extra being Obsidian's own `runAsyncLinkUpdate`. Measured on 1.14.2 at 50k notes,
 * a 1000-note folder took 924 s, 473 s of it in 2001 walks, with the renderer unresponsive for minutes.
 *
 * This suite wraps `iterateAllRefs`, renames a folder of {@link RENAME_WALK_MOVED_NOTE_COUNT} notes with
 * `shouldHandleRenames` on (seeded in `data.json`), and asserts the walk count stays a constant rather than growing
 * with F. It also asserts every holder's links resolve again afterwards. Each holder links to every moved note by
 * its full path, so its links go stale when the folder moves, and the handler suppresses Obsidian's own rewrite of
 * them. The only thing that can bring them back is the handler's own backlink capture, so a lookup that missed a
 * backlink leaves a link unresolved here.
 *
 * The rename is FIRED and the polls run in Node, for the reason this repo's `AGENTS.md` gives under the transport
 * cap. The rename's effects arriving is not the queue being empty, so the queue is drained afterwards too.
 */

const SCENARIO_TIMEOUT_IN_MS = 300_000;
const INDEX_WAIT_IN_MS = 120_000;
const RENAME_WAIT_IN_MS = 180_000;

/**
 * How many whole-vault walks one folder rename may take, whatever its size: Obsidian's own
 * `runAsyncLinkUpdate` walk, which runs once per `renameFile`. Measured at exactly 1 once the handler's lookups
 * went through `BacklinkIndex`; the same scenario took 2F + 1 = 81 before.
 */
const MAX_WALKS_PER_FOLDER_RENAME = 1;

const RENAMED_FOLDER = `${RENAME_WALK_MOVED_FOLDER}-renamed`;

/**
 * What the index and rename polls report back to Node.
 */
interface LinkProbe {
  readonly renameError: null | string;
  readonly resolvedHolderLinkCount: number;
  readonly unresolvedHolderLinks: string[];
}

/**
 * What {@link probeHolderLinks} waits for, and whether it fires the folder rename first.
 */
interface ProbeHolderLinksParams {
  readonly start?: boolean;
  readonly targetFolder: string;
  readonly timeoutInMilliseconds: number;
}

/**
 * The page-side state shared across the scenario's calls through a {@link ContextId}.
 */
interface RenameWalkContext {
  originalIterateAllRefs?: MetadataCache['iterateAllRefs'];
  renameError?: string;
  walkCount?: number;
}

describe('folder rename backlink walks', () => {
  it('walks the vault a constant number of times, not twice per renamed note, and leaves every link resolving', async () => {
    const contextId = new ContextId<RenameWalkContext>();
    const vaultPath = getTemporaryVault().path;
    const expectedHolderLinkCount = RENAME_WALK_HOLDER_COUNT * RENAME_WALK_MOVED_NOTE_COUNT;

    try {
      const indexed = await probeHolderLinks({ targetFolder: RENAME_WALK_MOVED_FOLDER, timeoutInMilliseconds: INDEX_WAIT_IN_MS });
      expect(indexed.resolvedHolderLinkCount).toBe(expectedHolderLinkCount);

      await evalInObsidian({
        async callback({ app, context, pluginId }): Promise<void> {
          if (!app.plugins.enabledPlugins.has(pluginId)) {
            await app.plugins.enablePlugin(pluginId);
          }

          context.walkCount = 0;
          const metadataCache = app.metadataCache;
          const originalIterateAllRefs = metadataCache.iterateAllRefs.bind(metadataCache);
          context.originalIterateAllRefs = originalIterateAllRefs;
          metadataCache.iterateAllRefs = (callback): void => {
            context.walkCount = (context.walkCount ?? 0) + 1;
            originalIterateAllRefs(callback);
          };
        },
        contextId,
        input: { pluginId: PLUGIN_ID },
        vaultPath
      });

      const renamed = await probeHolderLinks({
        start: true,
        targetFolder: RENAMED_FOLDER,
        timeoutInMilliseconds: RENAME_WAIT_IN_MS
      });
      if (renamed.renameError !== null) {
        throw new Error(`the folder rename rejected: ${renamed.renameError}`);
      }

      await drainQueue();

      const walkCount = await evalInObsidian({
        callback({ context }): number {
          return context.walkCount ?? -1;
        },
        contextId,
        vaultPath
      });

      expect(renamed.unresolvedHolderLinks).toEqual([]);
      expect(renamed.resolvedHolderLinkCount).toBe(expectedHolderLinkCount);
      expect(walkCount).toBeLessThanOrEqual(MAX_WALKS_PER_FOLDER_RENAME);
    } finally {
      await drainQueue();
      await evalInObsidian({
        callback({ app, context }): void {
          if (context.originalIterateAllRefs) {
            app.metadataCache.iterateAllRefs = context.originalIterateAllRefs;
          }
        },
        contextId,
        vaultPath
      });
      await contextId.dispose();
    }

    /**
     * Drains the handler's operation queue, after the effects being waited for have arrived, so no work of this
     * suite is still in flight when the next one starts. A rejection is swallowed: this also runs on the failure
     * path, and a stuck queue must not replace the assertion that actually failed.
     */
    async function drainQueue(): Promise<void> {
      try {
        await evalInObsidian({
          async callback({ lib: { flushQueue } }): Promise<void> {
            await flushQueue();
          },
          vaultPath
        });
      } catch {
        // Reported by whatever the scenario itself found, which is the more useful failure.
      }
    }

    /**
     * Polls, from Node, until every holder link resolves to a note under `targetFolder`, optionally firing the
     * folder rename first. The rename is not awaited: its rejection is stashed in the shared context and reported
     * by the poll.
     *
     * @param params - The folder the links must resolve into, whether to fire the rename, and the poll's budget.
     * @returns The last probe.
     */
    async function probeHolderLinks(params: ProbeHolderLinksParams): Promise<LinkProbe> {
      const isStarting = params.start ?? false;
      return await pollInObsidian({
        contextId,
        input: {
          holdersFolder: RENAME_WALK_HOLDERS_FOLDER,
          isStarting,
          movedFolder: RENAME_WALK_MOVED_FOLDER,
          renamedFolder: RENAMED_FOLDER,
          targetFolder: params.targetFolder
        },
        poll({ app, context, holdersFolder, targetFolder }): LinkProbe {
          let resolvedHolderLinkCount = 0;
          const unresolvedHolderLinks: string[] = [];
          for (const holder of app.vault.getMarkdownFiles()) {
            if (!holder.path.startsWith(`${holdersFolder}/`)) {
              continue;
            }
            for (const link of app.metadataCache.getFileCache(holder)?.links ?? []) {
              const target = app.metadataCache.getFirstLinkpathDest(link.link, holder.path);
              if (target?.path.startsWith(`${targetFolder}/`)) {
                resolvedHolderLinkCount++;
              } else {
                unresolvedHolderLinks.push(`${holder.path}: ${link.original}`);
              }
            }
          }
          return {
            renameError: context.renameError ?? null,
            resolvedHolderLinkCount,
            unresolvedHolderLinks
          };
        },
        start({ app, context, isStarting: shouldRename, movedFolder, renamedFolder }): void {
          if (!shouldRename) {
            return;
          }
          const folder = app.vault.getFolderByPath(movedFolder);
          if (!folder) {
            throw new Error(`Folder ${movedFolder} not found.`);
          }
          app.fileManager.renameFile(folder, renamedFolder).catch((error: unknown) => {
            context.renameError = error instanceof Error ? error.message : String(error);
          });
        },
        timeoutInMilliseconds: params.timeoutInMilliseconds,
        timeoutMessage: `the holder links never all resolved into ${params.targetFolder}`,
        until: (probe: LinkProbe): boolean => probe.renameError !== null || (probe.unresolvedHolderLinks.length === 0 && probe.resolvedHolderLinkCount === expectedHolderLinkCount),
        vaultPath
      });
    }
  }, SCENARIO_TIMEOUT_IN_MS);
});
