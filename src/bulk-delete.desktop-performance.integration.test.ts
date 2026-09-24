import type { GetAvailablePathForAttachmentsExtendedFunctionParams } from 'obsidian-dev-utils/obsidian/attachment-path';

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
  PERFORMANCE_VAULT_BASELINE_FOLDER,
  PERFORMANCE_VAULT_NOTE_COUNT,
  PERFORMANCE_VAULT_PRIMARY_FOLDER,
  PLUGIN_ID
} from '../scripts/generate-performance-vault.ts';

/*
 * Real-Obsidian reproduction of the bulk-deletion freeze. When a folder of N notes is
 * deleted in one burst, Obsidian fires one `vault.on('delete')` per descendant, and this
 * plugin's `RenameDeleteHandlerComponent` runs `DeleteHandler.handle()` for each —
 * resolving the note's attachment folder via
 * `app.vault.getAvailablePathForAttachments.extended`. That `extended` seam is exactly
 * what `custom-attachment-location` patches with its expensive resolver in the real vault,
 * so a bulk delete becomes O(N) expensive resolutions and freezes the UI.
 *
 * This test installs its OWN counting + delaying `extended` stub standing in for
 * `custom-attachment-location` (the temp vault has no such plugin), so the cost is
 * deterministic and the structural bottleneck is provable without a 90k-file vault:
 *
 *   - With the plugin ENABLED and `shouldHandleDeletions` on (seeded in data.json),
 *     deleting N notes must call the resolver exactly N times and take ~N × per-call
 *     cost — the O(N) freeze signature.
 *   - With the plugin DISABLED (the tripwire baseline), deleting N notes must call the
 *     resolver zero times — proving the handler, not the deletion itself, is the cost.
 *
 * ## The waiting happens in NODE, and here more than anywhere else it had to
 *
 * Both scenarios used to be ONE `evalInObsidian` closure apiece, declaring 245 625 ms and
 * 180 125 ms of deadline-bounded polling — eight and six times what one `Runtime.evaluate`
 * is given on this project, which takes the transport's 30s default rather than the raised
 * `commandTimeoutInMilliseconds` the `desktop` project sets. The success path is fast, so
 * they passed; it is the FAILURE path that was unreachable, and on the second scenario that
 * failure is the interesting outcome — its whole point is a FIFO drain marker whose
 * non-arrival means the fix regressed. The transport converted exactly that into a bare
 * `script timeout` naming `AppiumTransport.evaluate` / a CDP command timeout, i.e. into a
 * harness fault.
 *
 * Lowering the deadlines was never available: a bulk delete of 200 notes through a serial
 * queue at 25 ms a resolution is minutes of real work by construction, which is what the
 * numbers were sized for. So the long waits are Node's now, one short `poll` at a time, and
 * the deletions they wait on are FIRED rather than awaited — `start` kicks each burst off
 * and stashes its timings in the shared `context`, which is what the `contextId` parameter
 * exists for. Nothing about what is measured changed: the same two counters and the same
 * two wall-clock spans, taken from the same `performance.now()` clock inside the same page.
 */

const SCENARIO_TIMEOUT_IN_MS = 300_000;

// Time to wait for Obsidian's startup scan to index both bulk folders before deleting. The poll interval is `pollInObsidian`'s own 500 ms default, which is what this file used to spell out.
const INDEX_WAIT_IN_MS = 60_000;

// Time to wait for the dev-utils operation queue to drain the per-note delete handlers.
const QUEUE_DRAIN_WAIT_IN_MS = 180_000;
const QUEUE_DRAIN_POLL_IN_MS = 100;

// After deleting with the plugin disabled, the test lets any stray queued work settle and then asserts the resolver was never called.
const BASELINE_SETTLE_IN_MS = 5000;

// Models custom-attachment-location's expensive resolver: each per-note resolution costs this much, so a bulk delete of N notes costs about N times this cost. Chosen large enough that the handler's serial cost dominates real trash-I/O jitter.
const SIMULATED_ATTACHMENT_PATH_COST_IN_MS = 25;

// The enabled bulk delete must take at least this fraction of the modeled linear cost (N × per-call cost). The drain loop waits for all N resolutions, so this floor is robust.
const MIN_LINEAR_COST_FRACTION = 0.5;

/**
 * The O(N) scenario's page-side state, shared across its calls through a {@link ContextId}.
 *
 * None of it can cross the transport: the resolver is an installed function, and the timings are written by
 * a deletion burst that outlives the call that fired it.
 */
interface BulkDeleteContext {
  /**
   * How long the baseline deletion loop took, written when that fired-and-forgotten loop finishes.
   *
   * Its absence is what the Node-side poll waits on, so it doubles as the loop's done flag.
   */
  baselineDurationInMilliseconds?: number;

  enabledStartTimeInMilliseconds?: number;

  /**
   * Whether the enabled phase's deletion burst has finished issuing its deletions.
   *
   * Required alongside the resolver count before the baseline phase may disable the plugin: the count
   * reaching N says every handler ran, not that the loop that fired them has returned, and the original
   * shape awaited that loop.
   */
  isEnabledBurstDone?: boolean;
  resolverCallCount?: number;
}

/**
 * What the O(N) scenario's drain poll reports back to Node.
 */
interface DrainProbe {
  readonly elapsedInMilliseconds: number;
  readonly isBurstDone: boolean;
  readonly resolverCallCount: number;
}

/**
 * The index-only scenario's page-side state, shared across its calls through a {@link ContextId}.
 *
 * The resolver buckets its calls by the note being resolved: the marker (a real deletion), a synthetic
 * index-only note, or anything unexpected.
 */
interface IndexOnlyContext {
  markerResolverCalls?: number;
  otherResolverCalls?: number;
  syntheticResolverCalls?: number;
}

describe('bulk-deletion delete-handler bottleneck', () => {
  it('resolves the attachment path once per deleted note (O(N) freeze), and not at all without the handler', async () => {
    const contextId = new ContextId<BulkDeleteContext>();
    const vaultPath = getTemporaryVault().path;

    try {
      // Both bulk folders have to be in the index before anything is deleted, and a cold startup scan of them is genuinely a minute's work — so Node waits for it.
      // Counted per folder, because the same vault also seeds the `rename-walk` suite's notes.
      const observedNoteCount = await pollInObsidian({
        input: { bulkFolders: [PERFORMANCE_VAULT_PRIMARY_FOLDER, PERFORMANCE_VAULT_BASELINE_FOLDER] },
        poll({ app, bulkFolders }): number {
          return app.vault.getMarkdownFiles().filter((file) => bulkFolders.some((folder) => file.path.startsWith(`${folder}/`))).length;
        },
        timeoutInMilliseconds: INDEX_WAIT_IN_MS,
        timeoutMessage: 'the vault did not index both bulk folders in time',
        until: (noteCount: number): boolean => noteCount >= PERFORMANCE_VAULT_NOTE_COUNT * 2,
        vaultPath
      });

      const primaryNoteCount = await installResolver();
      expect(primaryNoteCount).toBe(PERFORMANCE_VAULT_NOTE_COUNT);

      const enabled = await runEnabledPhase();
      const baseline = await runBaselinePhase(enabled.resolverCallCount);

      // Both bulk folders were indexed before the test deleted anything.
      expect(observedNoteCount).toBe(PERFORMANCE_VAULT_NOTE_COUNT * 2);
      // The freeze signature: one expensive attachment-path resolution per deleted note.
      expect(enabled.resolverCallCount).toBe(PERFORMANCE_VAULT_NOTE_COUNT);
      // Without the delete handler, deleting the same number of notes resolves nothing.
      expect(baseline.resolverCallCount).toBe(0);
      // The enabled bulk delete spends at least the modeled handler cost (~N × per-call cost), so its wall-time grows linearly with the note count — the freeze.
      expect(enabled.elapsedInMilliseconds).toBeGreaterThanOrEqual(
        PERFORMANCE_VAULT_NOTE_COUNT * SIMULATED_ATTACHMENT_PATH_COST_IN_MS * MIN_LINEAR_COST_FRACTION
      );
    } finally {
      await contextId.dispose();
    }

    /**
     * Installs the counting and delaying resolver into the seam custom-attachment-location patches.
     *
     * The handler reads `app.vault.getAvailablePathForAttachments.extended`, and the count lives in the
     * shared `context` so the later calls can read it back.
     *
     * @returns How many notes the primary bulk folder holds, which the caller asserts is the expected count.
     */
    async function installResolver(): Promise<number> {
      return await evalInObsidian({
        callback({
          app,
          context,
          primaryFolder,
          simulatedCostInMilliseconds
        }): number {
          // Path whose parent folder does not exist, so the delete handler resolves it, finds no attachment folder, and returns after exactly one resolver call.
          const NONEXISTENT_ATTACHMENT_PATH = '__perf_nonexistent_attachment_folder__/dummy.png';

          context.resolverCallCount = 0;
          Object.assign(app.vault.getAvailablePathForAttachments, {
            extended: async (): Promise<string> => {
              await sleep(simulatedCostInMilliseconds);
              context.resolverCallCount = (context.resolverCallCount ?? 0) + 1;
              return NONEXISTENT_ATTACHMENT_PATH;
            }
          });

          return app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${primaryFolder}/`)).length;
        },
        contextId,
        input: {
          primaryFolder: PERFORMANCE_VAULT_PRIMARY_FOLDER,
          simulatedCostInMilliseconds: SIMULATED_ATTACHMENT_PATH_COST_IN_MS
        },
        vaultPath
      });
    }

    /**
     * Runs the baseline phase: the same bulk delete with no delete handler registered.
     *
     * Baseline calls are the delta over the enabled total, which avoids resetting the shared counter. The
     * settle that follows the loop only gives any stray handler a chance to run and must not count toward
     * the baseline timing, so the loop's own span is taken inside the page as the loop ends.
     *
     * @param enabledResolverCallCount - The counter's value when the enabled phase finished.
     * @returns The baseline span and the resolutions the baseline alone produced.
     */
    async function runBaselinePhase(enabledResolverCallCount: number): Promise<DrainProbe> {
      await evalInObsidian({
        async callback({
          app,
          baselineFolder,
          context,
          pluginId
        }): Promise<void> {
          await app.plugins.disablePlugin(pluginId);
          const baselineFiles = app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${baselineFolder}/`));

          /*
           * Fired, not awaited: 200 deletions is minutes of real work, and awaiting it here would put the
           * whole burst back inside one transport call. The duration it writes at the end is what the poll
           * below waits on.
           */
          (async (): Promise<void> => {
            const baselineStart = performance.now();
            for (const file of baselineFiles) {
              await app.fileManager.trashFile(file);
            }
            context.baselineDurationInMilliseconds = performance.now() - baselineStart;
          })().catch(() => {
            /*
             * A burst that dies part-way never writes its duration, so the poll below times out naming the
             * loop rather than the harness — which is the whole point of moving the waiting out here.
             */
          });
        },
        contextId,
        input: {
          baselineFolder: PERFORMANCE_VAULT_BASELINE_FOLDER,
          pluginId: PLUGIN_ID
        },
        vaultPath
      });

      const baselineDurationInMilliseconds = await pollInObsidian({
        contextId,
        intervalInMilliseconds: QUEUE_DRAIN_POLL_IN_MS,
        poll({ context }): number {
          return context.baselineDurationInMilliseconds ?? -1;
        },
        timeoutInMilliseconds: QUEUE_DRAIN_WAIT_IN_MS,
        timeoutMessage: 'the baseline deletion loop never finished',
        until: (durationInMilliseconds: number): boolean => durationInMilliseconds >= 0,
        vaultPath
      });

      const totalResolverCallCount = await evalInObsidian({
        async callback({
          app,
          context,
          pluginId,
          settleInMilliseconds
        }): Promise<number> {
          await sleep(settleInMilliseconds);
          const callCount = context.resolverCallCount ?? 0;
          await app.plugins.enablePlugin(pluginId);
          return callCount;
        },
        contextId,
        input: {
          pluginId: PLUGIN_ID,
          settleInMilliseconds: BASELINE_SETTLE_IN_MS
        },
        vaultPath
      });

      return {
        elapsedInMilliseconds: baselineDurationInMilliseconds,
        isBurstDone: true,
        resolverCallCount: totalResolverCallCount - enabledResolverCallCount
      };
    }

    /**
     * Runs the enabled phase: a bulk delete while the plugin handles deletions.
     *
     * The resolver count starts at zero (nothing has been deleted yet), so it is never reset. `start` fires
     * the deletion burst and records the clock reading it began at; the poll reports how far past that
     * reading each sample is taken, so the span is measured inside the page on one clock rather than across
     * the transport.
     *
     * @returns The span the burst took to produce every resolution, and how many it produced.
     */
    async function runEnabledPhase(): Promise<DrainProbe> {
      return await pollInObsidian({
        contextId,
        input: { primaryFolder: PERFORMANCE_VAULT_PRIMARY_FOLDER },
        intervalInMilliseconds: QUEUE_DRAIN_POLL_IN_MS,
        poll({ context }): DrainProbe {
          return {
            elapsedInMilliseconds: performance.now() - (context.enabledStartTimeInMilliseconds ?? performance.now()),
            isBurstDone: context.isEnabledBurstDone ?? false,
            resolverCallCount: context.resolverCallCount ?? 0
          };
        },
        start({ app, context, primaryFolder }): void {
          const primaryFiles = app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${primaryFolder}/`));
          context.enabledStartTimeInMilliseconds = performance.now();
          context.isEnabledBurstDone = false;

          // Fired, not awaited — see the baseline phase for why.
          (async (): Promise<void> => {
            for (const file of primaryFiles) {
              await app.fileManager.trashFile(file);
            }
            context.isEnabledBurstDone = true;
          })().catch(() => {
            // A burst that dies part-way stops producing resolutions, so the poll times out naming the queue.
          });
        },
        timeoutInMilliseconds: QUEUE_DRAIN_WAIT_IN_MS,
        timeoutMessage: 'the delete-handler queue never produced one resolution per deleted note',
        // Both halves: the count says every handler ran, the flag says the loop that fired them has returned, and the baseline phase must not disable the plugin under a live burst.
        until: (probe: DrainProbe): boolean => probe.isBurstDone && probe.resolverCallCount >= PERFORMANCE_VAULT_NOTE_COUNT,
        vaultPath
      });
    }
  }, SCENARIO_TIMEOUT_IN_MS);

  /*
   * End-to-end confirmation of the freeze FIX. The freeze was driven by INDEX-ONLY removals: hiding a
   * folder removes each descendant from Obsidian's index (firing one `vault.on('delete')` per note) while
   * the file stays on disk. The fix makes the delete handler skip any "delete" whose path still exists on
   * disk — the `await this.app.vault.adapter.exists(this.file.path)` guard in
   * `src/rename-delete-handler-component.ts` — so those synthetic removals resolve zero attachment paths:
   * no per-note resolver storm, no freeze.
   *
   * The O(N) test above uses REAL `trashFile` deletions (file leaves disk), which the guard
   * does NOT — and should not — skip, so it never exercises the fix. This case fires a
   * synthetic `vault.on('delete')` per note WITHOUT removing it from disk and asserts the
   * handler resolves nothing.
   *
   * To prove the synthetic handlers actually RAN (rather than asserting zero against work that
   * never started), it enqueues a single REAL deletion LAST as a drain marker. The dev-utils
   * operation queue is strictly serial/FIFO, so once the marker's resolution is observed every
   * prior synthetic handler has already drained. The resolver stub buckets calls by note path,
   * so the marker's one resolution is distinguishable from any (regression-only) synthetic one.
   *
   * The marker's NON-arrival is the interesting outcome here, which is precisely what the old
   * shape could not report: at 180 125 ms inside one transport call, a regression died as a
   * bare script timeout naming the harness. Node owns that budget now.
   */
  it('skips the delete handler for index-only removals, resolving no attachment paths', async () => {
    const contextId = new ContextId<IndexOnlyContext>();
    const vaultPath = getTemporaryVault().path;

    try {
      await stageIndexOnlyRemovals();

      // The FIFO drain marker: a single REAL deletion enqueued after every synthetic op, so its resolution can only happen once all prior synthetic ops have drained.
      await pollInObsidian({
        contextId,
        intervalInMilliseconds: QUEUE_DRAIN_POLL_IN_MS,
        poll({ context }): number {
          return context.markerResolverCalls ?? 0;
        },
        timeoutInMilliseconds: QUEUE_DRAIN_WAIT_IN_MS,
        timeoutMessage: 'the drain marker\'s deletion never resolved an attachment path',
        until: (markerResolverCalls: number): boolean => markerResolverCalls > 0,
        vaultPath
      });

      const result = await readResolverBuckets();

      // The marker (a real deletion) drained the serial queue, proving the synthetic handlers actually ran rather than never starting.
      expect(result.markerResolverCalls).toBe(1);
      // The fix: every index-only removal (file still on disk) is skipped, so none of them resolve an attachment path.
      expect(result.syntheticResolverCalls).toBe(0);
      // Sanity: nothing other than the marker was ever resolved.
      expect(result.otherResolverCalls).toBe(0);
    } finally {
      await contextId.dispose();
    }

    /**
     * Reads the three buckets the resolver stub filled.
     *
     * @returns How many resolutions the marker, the synthetic notes and anything else produced.
     */
    async function readResolverBuckets(): Promise<Required<IndexOnlyContext>> {
      return await evalInObsidian({
        callback({ context }): Required<IndexOnlyContext> {
          return {
            markerResolverCalls: context.markerResolverCalls ?? 0,
            otherResolverCalls: context.otherResolverCalls ?? 0,
            syntheticResolverCalls: context.syntheticResolverCalls ?? 0
          };
        },
        contextId,
        vaultPath
      });
    }

    /**
     * Installs the bucketing resolver, creates the notes that stay on disk, fires one index-only removal per
     * note, and enqueues the real deletion that marks the end of the queue.
     */
    async function stageIndexOnlyRemovals(): Promise<void> {
      await evalInObsidian({
        async callback({
          app,
          context,
          indexOnlyDeleteCount,
          simulatedCostInMilliseconds
        }): Promise<void> {
          const SYNTHETIC_FOLDER = '__perf_index_only_delete__';
          const MARKER_PATH = `${SYNTHETIC_FOLDER}/__drain_marker__.md`;
          const NONEXISTENT_ATTACHMENT_PATH = '__perf_nonexistent_attachment_folder__/dummy.png';

          context.markerResolverCalls = 0;
          context.otherResolverCalls = 0;
          context.syntheticResolverCalls = 0;
          Object.assign(app.vault.getAvailablePathForAttachments, {
            extended: async (params: GetAvailablePathForAttachmentsExtendedFunctionParams): Promise<string> => {
              await sleep(simulatedCostInMilliseconds);
              const notePath = typeof params.notePathOrFile === 'string' ? params.notePathOrFile : params.notePathOrFile?.path ?? '';
              if (notePath === MARKER_PATH) {
                context.markerResolverCalls = (context.markerResolverCalls ?? 0) + 1;
              } else if (notePath.startsWith(`${SYNTHETIC_FOLDER}/`)) {
                context.syntheticResolverCalls = (context.syntheticResolverCalls ?? 0) + 1;
              } else {
                context.otherResolverCalls = (context.otherResolverCalls ?? 0) + 1;
              }
              return NONEXISTENT_ATTACHMENT_PATH;
            }
          });

          // Create N notes that REMAIN on disk. Firing `vault.on('delete')` for each is an index-only removal (what hiding a folder does), so the handler's disk-existence guard must skip every one.
          await app.vault.createFolder(SYNTHETIC_FOLDER);
          const syntheticFiles: Awaited<ReturnType<typeof app.vault.create>>[] = [];
          for (let noteIndex = 0; noteIndex < indexOnlyDeleteCount; noteIndex++) {
            syntheticFiles.push(await app.vault.create(`${SYNTHETIC_FOLDER}/note-${String(noteIndex)}.md`, `# Note ${String(noteIndex)}\n`));
          }

          for (const file of syntheticFiles) {
            app.vault.trigger('delete', file);
          }

          const markerFile = await app.vault.create(MARKER_PATH, '# Marker\n');
          /*
           * Fired, not awaited: the marker's deletion is what the Node-side poll is waiting on, and awaiting
           * it here would make this closure wait for the whole synthetic queue ahead of it to drain.
           */
          app.fileManager.trashFile(markerFile).catch(() => {
            // A marker that never deletes never resolves, so the poll times out naming the marker.
          });
        },
        contextId,
        input: {
          indexOnlyDeleteCount: PERFORMANCE_VAULT_NOTE_COUNT,
          simulatedCostInMilliseconds: SIMULATED_ATTACHMENT_PATH_COST_IN_MS
        },
        vaultPath
      });
    }
  }, SCENARIO_TIMEOUT_IN_MS);
});
