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
  BASE_RENAME_BASE_PATH,
  BASE_RENAME_EMBEDDER_COUNT,
  BASE_RENAME_EMBEDDERS_FOLDER,
  PLUGIN_ID
} from '../scripts/generate-performance-vault.ts';

/*
 * Pins https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/issues/3: a base referenced by 903
 * notes is renamed, and every reference must follow it.
 *
 * `shouldHandleRenames` is on (seeded in `data.json`), so the handler suppresses Obsidian's own rewrite of these
 * references and is the only thing that can bring them back. The base sits in a subfolder with spaces and
 * parentheses in its name, as the reporter's did, and the embedders reference it in every shape
 * `generate-performance-vault.ts` lists, so a shape the rewrite mishandles leaves a reference that resolves to
 * nothing.
 *
 * The rename is FIRED and the poll runs in Node, for the reason this repo's `AGENTS.md` gives under the transport
 * cap. The rename's effects arriving is not the queue being empty, so the queue is drained afterwards too.
 */

const SCENARIO_TIMEOUT_IN_MS = 300_000;
const INDEX_WAIT_IN_MS = 120_000;
const RENAME_WAIT_IN_MS = 180_000;

/**
 * How many unresolved references a probe reports by name. The count is always complete.
 */
const MAX_REPORTED_UNRESOLVED_REFERENCES = 10;

const RENAMED_BASE_PATH = BASE_RENAME_BASE_PATH.replace(/\.base$/, '1111.base');

/**
 * The page-side state shared across the scenario's calls through a {@link ContextId}.
 */
interface BaseRenameContext {
  consoleErrors?: string[];
  originalConsoleError?: typeof console.error;
  renameError?: string;
}

/**
 * What {@link probeReferences} waits for, and whether it fires the base rename first.
 */
interface ProbeReferencesParams {
  readonly start?: boolean;
  readonly targetPath: string;
  readonly timeoutInMilliseconds: number;
}

/**
 * What the reference polls report back to Node.
 */
interface ReferenceProbe {
  readonly consoleErrors: string[];
  readonly renameError: null | string;
  readonly resolvedReferenceCount: number;
  readonly unresolvedReferenceCount: number;
  readonly unresolvedReferences: string[];
}

describe('base rename', () => {
  it(`updates every reference to a base referenced by ${String(BASE_RENAME_EMBEDDER_COUNT)} notes`, async () => {
    const contextId = new ContextId<BaseRenameContext>();
    const vaultPath = getTemporaryVault().path;

    try {
      await evalInObsidian({
        async callback({ app, context, pluginId }): Promise<void> {
          if (!app.plugins.enabledPlugins.has(pluginId)) {
            await app.plugins.enablePlugin(pluginId);
          }

          /*
           * The report shows only the plugin's "An unhandled error occurred" notice; the error itself goes to the
           * console. Collect it, so a failure here names it instead of only counting the references it left behind.
           */
          const consoleErrors: string[] = [];
          context.consoleErrors = consoleErrors;
          const originalConsoleError = console.error;
          context.originalConsoleError = originalConsoleError;
          console.error = (...consoleArguments: unknown[]): void => {
            consoleErrors.push(consoleArguments.map((argument) => argument instanceof Error ? argument.stack ?? argument.message : String(argument)).join(' '));
            originalConsoleError(...consoleArguments);
          };
        },
        contextId,
        input: { pluginId: PLUGIN_ID },
        vaultPath
      });

      const indexed = await probeReferences({ targetPath: BASE_RENAME_BASE_PATH, timeoutInMilliseconds: INDEX_WAIT_IN_MS });
      expect(indexed.resolvedReferenceCount).toBe(BASE_RENAME_EMBEDDER_COUNT);

      const renamed = await probeReferences({ start: true, targetPath: RENAMED_BASE_PATH, timeoutInMilliseconds: RENAME_WAIT_IN_MS });
      if (renamed.renameError !== null) {
        throw new Error(`the base rename rejected: ${renamed.renameError}`);
      }

      await drainQueue();

      expect(renamed.consoleErrors).toEqual([]);
      expect(renamed.unresolvedReferences).toEqual([]);
      expect(renamed.resolvedReferenceCount).toBe(BASE_RENAME_EMBEDDER_COUNT);
    } finally {
      await drainQueue();
      await evalInObsidian({
        callback({ context }): void {
          if (context.originalConsoleError) {
            console.error = context.originalConsoleError;
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
     * Polls, from Node, until every embedder's reference resolves to `targetPath`, optionally firing the base rename
     * first. The rename is not awaited: its rejection is stashed in the shared context and reported by the poll, and
     * so is any console error, which ends the wait at once rather than letting it run out its budget.
     *
     * @param params - The path the references must resolve to, whether to fire the rename, and the poll's budget.
     * @returns The last probe.
     */
    async function probeReferences(params: ProbeReferencesParams): Promise<ReferenceProbe> {
      const isStarting = params.start ?? false;
      return await pollInObsidian({
        contextId,
        input: {
          basePath: BASE_RENAME_BASE_PATH,
          embeddersFolder: BASE_RENAME_EMBEDDERS_FOLDER,
          isStarting,
          maxReported: MAX_REPORTED_UNRESOLVED_REFERENCES,
          renamedBasePath: RENAMED_BASE_PATH,
          targetPath: params.targetPath
        },
        poll({ app, context, embeddersFolder, maxReported, targetPath }): ReferenceProbe {
          let resolvedReferenceCount = 0;
          const unresolvedReferences: string[] = [];
          for (const embedder of app.vault.getMarkdownFiles()) {
            if (!embedder.path.startsWith(`${embeddersFolder}/`)) {
              continue;
            }
            const cache = app.metadataCache.getFileCache(embedder);
            for (const reference of [...cache?.links ?? [], ...cache?.embeds ?? [], ...cache?.frontmatterLinks ?? []]) {
              const target = app.metadataCache.getFirstLinkpathDest(reference.link.split('#', 1)[0] ?? '', embedder.path);
              if (target?.path === targetPath) {
                resolvedReferenceCount++;
              } else {
                unresolvedReferences.push(`${embedder.path}: ${reference.original}`);
              }
            }
          }
          return {
            consoleErrors: [...context.consoleErrors ?? []],
            renameError: context.renameError ?? null,
            resolvedReferenceCount,
            unresolvedReferenceCount: unresolvedReferences.length,
            unresolvedReferences: unresolvedReferences.slice(0, maxReported)
          };
        },
        start({ app, basePath, context, isStarting: shouldRename, renamedBasePath }): void {
          if (!shouldRename) {
            return;
          }
          const base = app.vault.getFileByPath(basePath);
          if (!base) {
            throw new Error(`Base ${basePath} not found.`);
          }
          app.fileManager.renameFile(base, renamedBasePath).catch((error: unknown) => {
            context.renameError = error instanceof Error ? error.message : String(error);
          });
        },
        timeoutInMilliseconds: params.timeoutInMilliseconds,
        timeoutMessage: `the references never all resolved to ${params.targetPath}`,
        until: (probe: ReferenceProbe): boolean =>
          probe.renameError !== null
          || probe.consoleErrors.length > 0
          || (probe.unresolvedReferenceCount === 0 && probe.resolvedReferenceCount === BASE_RENAME_EMBEDDER_COUNT),
        vaultPath
      });
    }
  }, SCENARIO_TIMEOUT_IN_MS);
});
