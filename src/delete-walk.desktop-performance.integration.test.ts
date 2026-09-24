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
  DELETE_WALK_ATTACHMENT_COUNT,
  DELETE_WALK_DELETED_FOLDER,
  PLUGIN_ID
} from '../scripts/generate-performance-vault.ts';

/*
 * Counts the whole-vault backlink walks a protected folder deletion takes, and guards the half of them this
 * plugin owns.
 *
 * Deleting a folder whose attachments a note outside it still embeds goes through
 * `DeleteProtectionPatchComponent`: a pre-scan asking which attachments are still used, the unit-folder rescue
 * pre-pass asking again, and then the library's `deleteIfNotUsed` walking the folder. The first two are this
 * plugin's own `findSurvivingNotePaths` lookups, and they go through `BacklinkIndex`. The third calls the
 * library's `getBacklinksForFileSafe` from inside the library, once per file it visits, and each call is a full
 * `iterateAllRefs` walk that this plugin cannot redirect.
 *
 * The fixture is A embedded attachments plus one unlinked one, so the deletion walks the vault at most A + 1
 * times, once per file the library visits, and the suite asserts exactly that bound. Each pre-pass also asks once
 * per non-note file, so a pre-pass walking again fails it at 2(A + 1) + 1. Measured 2026-09-24 with A = 20 on
 * `obsidian-dev-utils` 105.0.0: 43 walks before the pre-passes went through the index, 1 after.
 *
 * That 1 is lower than A + 1 because of a defect in the library's walk, not because the walk is cheap:
 * `deleteIfNotUsed` folds each child's result into its folder's with `&&=`, which short-circuits, so the first
 * child it keeps ends the walk and no sibling after it is visited at all. The fixture's unlinked `unused.png` is
 * left behind for that reason. The suite therefore waits for the deletion to SETTLE rather than for that file to
 * go, and asserts nothing about it; once the library visits every child, its share rises to A + 1 and the
 * bound still holds.
 *
 * The deletion is FIRED and the poll runs in Node, for the reason this repo's `AGENTS.md` gives under the
 * transport cap. Its effect arriving is not the queue being empty, so the queue is drained afterwards too.
 */

const SCENARIO_TIMEOUT_IN_MS = 300_000;
const DELETE_WAIT_IN_MS = 180_000;

/**
 * How many whole-vault walks the folder deletion may take: the library's `deleteIfNotUsed`, once per file it
 * visits — the embedded attachments and the one unlinked file. Everything this plugin asks goes through
 * `BacklinkIndex` and walks nothing.
 */
const MAX_WALKS_PER_FOLDER_DELETE = DELETE_WALK_ATTACHMENT_COUNT + 1;

/**
 * What the deletion poll reports back to Node.
 */
interface DeleteProbe {
  readonly deleteError: null | string;
  readonly isDeleteSettled: boolean;
  readonly keptAttachmentCount: number;
}

/**
 * The page-side state shared across the scenario's calls through a {@link ContextId}.
 */
interface DeleteWalkContext {
  deleteError?: string;
  isDeleteSettled?: boolean;
  originalIterateAllRefs?: MetadataCache['iterateAllRefs'];
  walkCount?: number;
}

describe('folder delete backlink walks', () => {
  it('walks the vault only for the library\'s own per-file lookups, not for this plugin\'s pre-passes', async () => {
    const contextId = new ContextId<DeleteWalkContext>();
    const vaultPath = getTemporaryVault().path;

    try {
      await pollInObsidian({
        input: { folderPath: DELETE_WALK_DELETED_FOLDER },
        poll({ app, folderPath }): number {
          let resolvedEmbedCount = 0;
          for (const file of app.vault.getMarkdownFiles()) {
            for (const embed of app.metadataCache.getFileCache(file)?.embeds ?? []) {
              if (app.metadataCache.getFirstLinkpathDest(embed.link, file.path)?.path.startsWith(`${folderPath}/`)) {
                resolvedEmbedCount++;
              }
            }
          }
          return resolvedEmbedCount;
        },
        timeoutInMilliseconds: DELETE_WAIT_IN_MS,
        timeoutMessage: 'the holder\'s embeds were never indexed',
        until: (resolvedEmbedCount: number): boolean => resolvedEmbedCount === DELETE_WALK_ATTACHMENT_COUNT,
        vaultPath
      });

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

      const deleted = await pollInObsidian({
        contextId,
        input: { folderPath: DELETE_WALK_DELETED_FOLDER },
        poll({ app, context, folderPath }): DeleteProbe {
          return {
            deleteError: context.deleteError ?? null,
            isDeleteSettled: context.isDeleteSettled ?? false,
            keptAttachmentCount: app.vault.getFiles().filter((file) => file.path.startsWith(`${folderPath}/attachment-`)).length
          };
        },
        start({ app, context, folderPath }): void {
          const folder = app.vault.getFolderByPath(folderPath);
          if (!folder) {
            throw new Error(`Folder ${folderPath} not found.`);
          }
          app.fileManager.trashFile(folder)
            .then(() => {
              context.isDeleteSettled = true;
            })
            .catch((error: unknown) => {
              context.deleteError = error instanceof Error ? error.message : String(error);
            });
        },
        timeoutInMilliseconds: DELETE_WAIT_IN_MS,
        timeoutMessage: `the deletion of ${DELETE_WALK_DELETED_FOLDER} never settled`,
        until: (probe: DeleteProbe): boolean => probe.deleteError !== null || probe.isDeleteSettled,
        vaultPath
      });
      if (deleted.deleteError !== null) {
        throw new Error(`the folder deletion rejected: ${deleted.deleteError}`);
      }

      await drainQueue();

      const walkCount = await evalInObsidian({
        callback({ context }): number {
          return context.walkCount ?? -1;
        },
        contextId,
        vaultPath
      });

      expect(deleted.keptAttachmentCount).toBe(DELETE_WALK_ATTACHMENT_COUNT);
      expect(walkCount).toBeLessThanOrEqual(MAX_WALKS_PER_FOLDER_DELETE);
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
  }, SCENARIO_TIMEOUT_IN_MS);
});
