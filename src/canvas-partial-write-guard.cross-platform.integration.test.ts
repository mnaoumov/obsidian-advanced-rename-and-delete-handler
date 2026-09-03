import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

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
 * What this proves end to end: the rename completes, still relocates the embedded attachment, and leaves the
 * canvas file BYTE-IDENTICAL to what was written — no write happened, which is the guard holding. The
 * `{}`-shaped transient Advanced Canvas leaves mid-initialization cannot be staged headlessly; that half is
 * the second, deliberately skipped case below.
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
  readonly originalCanvasContent: string;
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
  migrateSettings(params: MigrateSettingsParamsLike): Promise<MigrateSettingsResultLike>;
}

interface PluginWithApiLike {
  readonly api: MigrationApiLike;
}

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
        const WAIT_TIMEOUT_IN_MILLISECONDS = 30_000;
        // Shorter than the project's own test timeout, so a missing effect is reported by an assertion rather than by vitest.
        const EFFECT_TIMEOUT_IN_MILLISECONDS = 10_000;

        const plugin = app.plugins.plugins[pluginId];
        if (!plugin) {
          throw new Error(`${pluginId} is not loaded`);
        }

        function hasApi(candidate: object): candidate is PluginWithApiLike {
          return 'api' in candidate;
        }

        if (!hasApi(plugin)) {
          throw new Error(`${pluginId} exposes no API`);
        }

        const api = plugin.api;

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

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          app.vault.setConfig('attachmentFolderPath', './assets');

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
           * therefore drains an empty queue and returns at once, leaving the canvas to be read while the
           * operation is still in flight and intermittently catching a transient re-serialized copy. Waiting
           * for the moved attachment proves the operation is underway; this waits for the rest of it.
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
            originalCanvasContent: partialCanvasContent
          };
        } finally {
          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
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
     * The guard itself: the partial canvas is left EXACTLY as it was written. Anything else means the
     * malformed shape was re-serialized, which is the corruption the issue is about — and a byte-identical
     * file is the strongest available evidence that no write happened at all.
     */
    expect(result.movedCanvasContent).toBe(result.originalCanvasContent);

    // Which leaves it a canvas Obsidian's renderer can still read: parseable, and carrying its nodes array.
    const parsedCanvas = JSON.parse(result.movedCanvasContent) as CanvasNodesProbe;
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
