import { evalInObsidian } from 'obsidian-integration-testing';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { PluginSettingsSnapshot } from './settings-snapshot.integration-helper.ts';

import {
  readPluginSettings,
  writePluginSettings
} from './settings-snapshot.integration-helper.ts';

/*
 * A rename that travels over a PARTIAL canvas — parsed JSON with a `nodes` array but no `edges` one — must
 * never write that malformed shape back to disk. Advanced Canvas leaves a freshly inserted canvas as `{}` or
 * partial while it initializes; re-serializing it made Obsidian's canvas renderer throw
 * `Cannot read properties of undefined (reading 'length')` / `data.edges is not iterable`. The guard skips
 * the write when `nodes` and `edges` are not both arrays.
 *
 * See https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/45.
 *
 * Named for what it guards. It was `canvas-non-canvas-guard` in `obsidian-custom-attachment-location`, whose
 * name reads as the opposite of the case it covers — every canvas here is a canvas, and what varies is
 * whether it is complete.
 *
 * What this proves end to end: the rename completes, still relocates the embedded attachment, and THIS PLUGIN
 * never writes the canvas — which is the guard holding — while the canvas keeps the data it was written with,
 * its file node at most re-pointed at the moved attachment by Obsidian itself. The `{}`-shaped transient Advanced Canvas leaves mid-initialization cannot be staged
 * headlessly; that half is the second, deliberately skipped case below.
 *
 * Why "this plugin never writes it" rather than "the file is byte-identical", which is what this suite used
 * to assert: Obsidian writes the canvas itself. The handler hands every link update whose source is a canvas
 * back to Obsidian's native updater, and that updater (`applyUpdates` in Obsidian's canvas link updater, read
 * out of the 1.14.2 bundle) rewrites only TEXT nodes but re-serializes the whole file in Obsidian's own
 * tab-indented, one-node-per-line format every time it runs, changed or not. It runs whenever Obsidian's canvas
 * index already holds the canvas when the attachment moves. Against a canvas created a few milliseconds earlier
 * that was a coin toss — the index usually lagged, so the file stayed byte-identical and the suite passed, and
 * about one desktop aggregate in three it did not, which read as a `flushQueue` ordering race. It was not one:
 * waiting for the index first, as the case below now does, fails the byte-identity assertion every time. A
 * canvas in a real vault is always indexed, so Obsidian's rewrite is the ordinary case, and the suite
 * now stages it deliberately.
 *
 * Ported from `obsidian-custom-attachment-location`, which deleted the suite when it stopped registering a
 * rename/delete handler. Rewritten rather than copied: the original assigned to a settings object it found by
 * walking the plugin's component tree and configured that plugin's own `attachmentFolderPath`, while here
 * settings go in through this plugin's `migrateSettings` API — its only public write path — and the
 * attachment folder is Obsidian's own vault config, which is what this plugin reads. Each case repeats its
 * own settings helper because an `evalInObsidian` callback is serialized and reaches nothing outside itself.
 *
 * Cross-platform: a partial canvas is as corruptible on a phone, and the manifest declares
 * `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface CanvasGuardResult {
  readonly hasAttachmentAtNewPath: boolean;
  readonly hasAttachmentAtOldPath: boolean;
  readonly movedCanvasContent: string;
  readonly newAttachmentPath: string;
  readonly oldAttachmentPath: string;
  readonly originalCanvasContent: string;
  readonly pluginCanvasWriteStacks: readonly string[];
}

interface CanvasNodesProbe {
  nodes?: unknown;
}

interface MigratableSettingsLike {
  readonly shouldHandleRenames?: boolean;
  readonly shouldRenameAttachmentFolder?: boolean;
}

interface MigrateSettingsParamsLike {
  readonly proposedSettings: MigratableSettingsLike;
  readonly sourcePluginId: string;
}

interface MigrateSettingsResultLike {
  readonly isApplied: boolean;
}

interface MigrationApiLike {
  migrateSettings: (params: MigrateSettingsParamsLike) => Promise<MigrateSettingsResultLike>;
}

interface ObsidianDevUtilsStateLike {
  readonly pluginApiRegistry?: PluginApiRegistryWrapperLike;
}

interface PathHolderLike {
  readonly path: string;
}

/**
 * The slice of the `obsidian-dev-utils` cross-plugin registry a closure reads the API from: the wire-level path
 * that library's Plugin API protocol guide freezes, so a suite reaches the plugin the way a consumer does.
 */
interface PluginApiRegistryHostLike {
  readonly __obsidianDevUtils?: ObsidianDevUtilsStateLike;
}

interface PluginApiRegistryLike {
  readonly records?: Partial<Record<string, readonly PublishedPluginApiRecordLike[]>>;
}

interface PluginApiRegistryWrapperLike {
  readonly value?: PluginApiRegistryLike;
}

interface PublishedPluginApiRecordLike {
  readonly api: MigrationApiLike;
  readonly isRevoked: boolean;
}

/*
 * This plugin's settings outlive each test file — one run drives every suite against one Obsidian instance —
 * so what this suite stages must not become the starting point of whichever file the sequencer runs next.
 * Handed back the way the `finally` blocks below hand back `attachmentFolderPath`. See
 * `settings-snapshot.integration-helper.ts`.
 */
let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('Moving a partial canvas', () => {
  it('relocates the attachment and leaves the canvas valid', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<CanvasGuardResult> {
        const SRC_FOLDER = 'rdh-canvas-guard-src';
        const DST_FOLDER = 'rdh-canvas-guard-dst';
        const SRC_CANVAS = `${SRC_FOLDER}/board.canvas`;
        const DST_CANVAS = `${DST_FOLDER}/board.canvas`;
        const SRC_ATTACHMENT = `${SRC_FOLDER}/assets/img.png`;
        const DST_ATTACHMENT = `${DST_FOLDER}/assets/img.png`;
        /*
         * Under the transport's ~30s per-closure cap, not at it. This closure's declared waits SUM to under
         * the cap rather than each one sitting AT it: at 30_000 the ceiling was unreachable, because the eval
         * is killed at the cap first and reported as a bare transport timeout naming the harness rather than
         * the wait that actually overran. A helper's budget is charged once per CALL SITE, so this one is
         * charged twice — `applySettings` runs at the start and again in the `finally` — which with
         * {@link INDEX_TIMEOUT_IN_MILLISECONDS} and {@link EFFECT_TIMEOUT_IN_MILLISECONDS} makes 28 000 ms in
         * total. What is waited on here lands in well under a second, so a budget this size costs nothing — a
         * wait that can genuinely run long belongs in `pollInObsidian`, with Node doing the waiting, as the two
         * note-move suites here now do.
         */
        const WAIT_TIMEOUT_IN_MILLISECONDS = 9000;
        // Measured at 50-160 ms from the canvas's creation to its entry in Obsidian's canvas index.
        const INDEX_TIMEOUT_IN_MILLISECONDS = 2000;
        // Shorter than the project's own test timeout, so a missing effect is reported by an assertion rather than by vitest.
        const EFFECT_TIMEOUT_IN_MILLISECONDS = 8000;

        const apiRecord = (window as PluginApiRegistryHostLike).__obsidianDevUtils?.pluginApiRegistry?.value?.records?.[pluginId]
          ?.find((candidate) => !candidate.isRevoked);
        if (!apiRecord) {
          throw new Error(`${pluginId} has published no API`);
        }

        const api = apiRecord.api;

        /**
         * Writes settings through the plugin's own migration API and approves the dialog it raises.
         *
         * A proposal that matches what the plugin already holds resolves with no dialog at all, so the wait
         * settles on either outcome rather than insisting on a modal that may never appear.
         *
         * @param proposedSettings - The settings to write.
         */
        async function applySettings(proposedSettings: MigratableSettingsLike): Promise<void> {
          const migrationPromise = api.migrateSettings({
            proposedSettings,
            sourcePluginId
          });
          let isSettled = false;
          /*
           * Never rejects — the `catch` absorbs it — so awaiting it below keeps it from floating, while the
           * migration's own rejection still surfaces from the `await` that follows.
           */
          const settlementPromise = migrationPromise
            .then(() => {
              isSettled = true;
            })
            .catch(() => {
              isSettled = true;
            });

          await waitUntil({
            message: 'the settings dialog opens, or the proposal turns out to change nothing',
            predicate: () => isSettled || document.querySelector('.modal-container') !== null,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const modalEl = document.querySelector('.modal-container');
          if (modalEl) {
            const okButton = [...modalEl.querySelectorAll('button')].find((button) => button.textContent === 'OK');
            if (!okButton) {
              throw new Error('the settings dialog has no OK button');
            }

            okButton.click();
          }

          await settlementPromise;
          const migrateSettingsResult = await migrationPromise;
          if (!migrateSettingsResult.isApplied) {
            throw new Error('the settings were not applied');
          }
        }

        const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');
        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');

        /*
         * Every write that reaches the canvas is recorded with the stack it was made from, and the ones made
         * from this plugin's code are what the guard forbids. Obsidian evaluates a plugin's bundle under the
         * source URL `plugin:<id>`, so a frame naming it is this plugin — including the `obsidian-dev-utils`
         * code bundled into it, which is where the guarded rewrite lives. Obsidian's own writes carry
         * `app://obsidian.md` frames only. Both the vault-level and adapter-level entry points are observed, so
         * a write taking either path is seen. Each observer shadows the method with an own property and the
         * `finally` removes it again, so the next suite on this shared instance meets the vault untouched.
         */
        const pluginFrameMarker = `plugin:${pluginId}:`;
        const pluginCanvasWriteStacks: string[] = [];
        const writeObserverRemovers: (() => void)[] = [];

        /**
         * Records every call of one write method whose target is a canvas, keeping the stacks made from this plugin.
         *
         * @param target - The vault or its adapter.
         * @param methodName - The write method to observe.
         * @param getPath - Reads the written path out of the method's first argument.
         */
        function observeCanvasWrites(target: object, methodName: string, getPath: (firstArgument: unknown) => string): void {
          const hasOwnMethod = Object.hasOwn(target, methodName);
          const originalMethod = Reflect.get(target, methodName) as (...methodArguments: unknown[]) => unknown;
          Object.assign(target, {
            [methodName](this: unknown, ...methodArguments: unknown[]): unknown {
              const path = getPath(methodArguments[0]);
              if (path.endsWith('.canvas')) {
                const stack = new Error(`${methodName} of ${path}`).stack ?? '';
                if (stack.includes(pluginFrameMarker)) {
                  pluginCanvasWriteStacks.push(stack);
                }
              }

              return originalMethod.apply(this, methodArguments);
            }
          });
          writeObserverRemovers.push(() => {
            if (hasOwnMethod) {
              Object.assign(target, { [methodName]: originalMethod });
            } else {
              Reflect.deleteProperty(target, methodName);
            }
          });
        }

        function getFilePath(file: unknown): string {
          return (file as PathHolderLike).path;
        }

        function getAdapterPath(path: unknown): string {
          return path as string;
        }

        observeCanvasWrites(app.vault, 'modify', getFilePath);
        observeCanvasWrites(app.vault, 'process', getFilePath);
        observeCanvasWrites(app.vault.adapter, 'process', getAdapterPath);
        observeCanvasWrites(app.vault.adapter, 'write', getAdapterPath);

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          app.vault.setConfig('attachmentFolderPath', './assets');
          /*
           * The handler hands the canvas's link update back to Obsidian's `updateAllLinks`. With this setting off,
           * that call would open its "Update links" confirmation, but the handler now answers it for every canvas
           * entry it hands back (`canvas-link-update-prompt` pins that). The setting stays on here so this suite
           * measures the guard alone, under the value the harness intends. The Android transport of the
           * `obsidian-integration-testing` release in use here loses that default before the vault opens, so it is
           * set here, as the sibling suites do.
           */
          app.vault.setConfig('alwaysUpdateLinks', true);

          await applySettings({
            shouldHandleRenames: true,
            shouldRenameAttachmentFolder: true
          });

          await app.vault.createFolder(`${SRC_FOLDER}/assets`);
          await app.vault.createFolder(DST_FOLDER);
          await app.vault.createBinary(SRC_ATTACHMENT, new ArrayBuffer(8));

          // A `nodes` array but NO `edges` one: the shape Advanced Canvas leaves behind mid-initialization.
          const partialCanvasContent = JSON.stringify(
            {
              nodes: [
                {
                  file: SRC_ATTACHMENT,
                  height: 300,
                  id: 'node1',
                  type: 'file',
                  width: 400,
                  x: 0,
                  y: 0
                }
              ]
            },
            null,
            2
          );
          const canvas = await app.vault.create(SRC_CANVAS, partialCanvasContent);

          /*
           * The state every real canvas is in: already indexed by Obsidian, which is what makes its native link
           * updater rewrite the file when the attachment moves. Renaming before the index caught up is what
           * made this suite's outcome depend on timing; see the header.
           */
          const canvasIndex = app.internalPlugins.getPluginById('canvas')?.instance.index;
          if (!canvasIndex) {
            throw new Error('the Canvas core plugin is not enabled');
          }

          await waitUntil({
            message: 'Obsidian\'s canvas index holds the canvas and its file node',
            predicate: () => (canvasIndex.index[SRC_CANVAS]?.embeds.length ?? 0) > 0,
            timeoutInMilliseconds: INDEX_TIMEOUT_IN_MILLISECONDS
          });

          await app.fileManager.renameFile(canvas, DST_CANVAS);

          /*
           * The timeout is swallowed deliberately: an attachment that never moves must be reported by the
           * path assertions below, which name where it actually is, rather than as an opaque wait failure.
           */
          try {
            await waitUntil({
              message: 'the embedded attachment has moved with the partial canvas',
              predicate: () => app.vault.getAbstractFileByPath(DST_ATTACHMENT) !== null,
              timeoutInMilliseconds: EFFECT_TIMEOUT_IN_MILLISECONDS
            });
          } catch {
            // Reported by the path assertions instead.
          }

          /*
           * Drained AFTER the move, not before. `flushQueue` appends a no-op and awaits the queue's promise
           * chain, so it only covers what is ALREADY enqueued when it is called — and the handler enqueues
           * its operation from the vault's `rename` event, after `renameFile` has resolved. Draining first
           * therefore drains an empty queue and returns at once, leaving the canvas to be read — and the write
           * observer below to be torn down — while the operation, and the canvas write the guard is there to
           * skip, is still in flight. Waiting for the moved attachment proves the operation is underway; this
           * waits for the rest of it.
           */
          await flushQueue();

          const movedCanvas = app.vault.getFileByPath(DST_CANVAS);
          if (!movedCanvas) {
            throw new Error(`Canvas ${DST_CANVAS} not found.`);
          }

          return {
            hasAttachmentAtNewPath: app.vault.getAbstractFileByPath(DST_ATTACHMENT) !== null,
            hasAttachmentAtOldPath: app.vault.getAbstractFileByPath(SRC_ATTACHMENT) !== null,
            movedCanvasContent: await app.vault.read(movedCanvas),
            newAttachmentPath: DST_ATTACHMENT,
            oldAttachmentPath: SRC_ATTACHMENT,
            originalCanvasContent: partialCanvasContent,
            pluginCanvasWriteStacks
          };
        } finally {
          for (const removeWriteObserver of writeObserverRemovers) {
            removeWriteObserver();
          }
          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
          // Back to the defaults declared in `src/plugin-settings.ts`, so the next suite starts where this one found things.
          await applySettings({
            shouldHandleRenames: true,
            shouldRenameAttachmentFolder: true
          });
          /*
           * Through the adapter, as the conflicting-plugin suite does: a fixture teardown must not travel
           * back through the very delete path this plugin patches, which would make the cleanup part of
           * what is under test.
           */
          for (const folderPath of [SRC_FOLDER, DST_FOLDER]) {
            if (await app.vault.adapter.exists(folderPath)) {
              await app.vault.adapter.rmdir(folderPath, true);
            }
          }
        }
      },
      input: {
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    // The rename over the partial canvas completed and still relocated the embedded attachment.
    expect(result.hasAttachmentAtNewPath).toBe(true);
    expect(result.hasAttachmentAtOldPath).toBe(false);

    /*
     * The guard itself: this plugin never wrote the partial canvas. A write from it is the malformed shape
     * being re-serialized, which is the corruption the issue is about. Removing the guard from the built
     * bundle fails exactly this assertion, on one `vault.process` from the bundled `applyFileChanges` and the
     * `adapter.process` it makes underneath.
     */
    expect(result.pluginCanvasWriteStacks).toEqual([]);

    /*
     * And the canvas holds the data it was written with: no `edges` array invented, no node added or dropped.
     * Compared as parsed data rather than as bytes, because Obsidian's own link updater re-serializes it in its
     * own format — see the header. The one field allowed to differ is the file node's path, and only by naming
     * the attachment's new home: Obsidian's canvas plugin re-points a file node at a moved file itself, on its
     * own schedule, so whether that has landed by the time the file is read is timing. Measured 2026-09-24 on
     * Android, where it landed in one run of two; the write assertion above already proved it was not this
     * plugin's write.
     */
    const parsedCanvas = JSON.parse(result.movedCanvasContent) as CanvasNodesProbe;
    const updatedFileNodeCanvasContent = result.originalCanvasContent.split(result.oldAttachmentPath).join(result.newAttachmentPath);
    expect([JSON.parse(result.originalCanvasContent), JSON.parse(updatedFileNodeCanvasContent)]).toContainEqual(parsedCanvas);

    // Which leaves it a canvas Obsidian's renderer can still read: parseable, and carrying its nodes array.
    expect(Array.isArray(parsedCanvas.nodes)).toBe(true);
  });

  /*
   * The guard-specific half — proving the canvas write is SKIPPED on malformed content rather than Obsidian
   * core performing a valid file-node rewrite — cannot be staged headlessly. It needs Advanced Canvas
   * installed and its mid-initialization race hit, where a freshly inserted canvas is transiently `{}`.
   * Skipped, not silently omitted; the guard itself is unit-covered in `obsidian-dev-utils`
   * (`file-change.test.ts`: `{}` and a partial `{"nodes":[…]}` both skip the write).
   *
   * MANUAL REPRO (real Obsidian, GUI):
   *   1. Install and enable this plugin and Advanced Canvas, with "Should handle renames" on.
   *   2. Insert a new canvas through Advanced Canvas's own affordance.
   *   3. Without the guard the insert throws `Cannot read properties of undefined (reading 'length')` /
   *      `data.edges is not iterable`; with it the canvas inserts cleanly. Turning "Should handle renames"
   *      off also avoids the error, which is the diagnostic tell that the write came from the handler.
   */
  it.skip('skips the write on the transient `{}` Advanced Canvas leaves mid-initialization', () => {
    // Intentionally empty: covered by the unit test upstream and by the manual recipe above.
  });
});
