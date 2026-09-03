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
 * Moving a `.canvas` moves the attachment it embeds, and rewrites the canvas's own file-node reference to
 * the attachment's new location.
 *
 * See https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/22.
 *
 * Obsidian does not index a canvas into the metadata cache, so the cache-derived outgoing links of a canvas
 * are empty and an attachment reachable only through it used to be left behind. `RenameMap.fill()` reads
 * `getCanvasReferences` for a canvas instead, which is the branch this pins.
 *
 * The attachment sits in a SHARED `./assets` folder — Obsidian's own `attachmentFolderPath` — rather than a
 * per-note one, so it is found through the canvas's references rather than by recursing a folder the note
 * owns. That is the branch the issue is about.
 *
 * Ported from `obsidian-custom-attachment-location`, which deleted the suite when it stopped registering a
 * rename/delete handler. Rewritten rather than copied: the original assigned to a settings object it found by
 * walking the plugin's component tree and configured that plugin's own `attachmentFolderPath`, while here
 * settings go in through this plugin's `migrateSettings` API — its only public write path — and the
 * attachment folder is Obsidian's own vault config, which is what this plugin reads. Each case repeats its
 * own settings helper because an `evalInObsidian` callback is serialized and reaches nothing outside itself.
 *
 * Cross-platform: a canvas moves the same way on a phone, and the manifest declares `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface CanvasMoveResult {
  readonly hasAttachmentAtNewPath: boolean;
  readonly hasAttachmentAtOldPath: boolean;
  readonly movedCanvasContent: string;
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

describe('Moving a canvas', () => {
  it('moves the attachment it embeds and rewrites the file-node reference', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<CanvasMoveResult> {
        const SRC_FOLDER = 'rdh-canvas-move-src';
        const DST_FOLDER = 'rdh-canvas-move-dst';
        const SRC_CANVAS = `${SRC_FOLDER}/board.canvas`;
        const DST_CANVAS = `${DST_FOLDER}/board.canvas`;
        const SRC_ATTACHMENT = `${SRC_FOLDER}/assets/img.png`;
        const DST_ATTACHMENT = `${DST_FOLDER}/assets/img.png`;
        const WAIT_TIMEOUT_IN_MILLISECONDS = 30_000;

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
          // A folder SHARED by every note beside it, so the attachment is reachable only through the canvas's own references.
          app.vault.setConfig('attachmentFolderPath', './assets');

          await applySettings({
            shouldHandleRenames: true,
            shouldRenameAttachmentFolder: true
          });

          await app.vault.createFolder(`${SRC_FOLDER}/assets`);
          await app.vault.createFolder(DST_FOLDER);
          await app.vault.createBinary(SRC_ATTACHMENT, new ArrayBuffer(8));

          const canvasData = {
            edges: [],
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
          };
          const canvas = await app.vault.create(SRC_CANVAS, JSON.stringify(canvasData, null, 2));

          await app.fileManager.renameFile(canvas, DST_CANVAS);
          // The handler moves the attachment and rewrites the canvas on its own queue, which this drains.
          await flushQueue();
          await waitUntil({
            message: 'the embedded attachment has moved with the canvas',
            predicate: () => app.vault.getAbstractFileByPath(DST_ATTACHMENT) !== null,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const movedCanvas = app.vault.getFileByPath(DST_CANVAS);
          if (!movedCanvas) {
            throw new Error(`Canvas ${DST_CANVAS} not found.`);
          }

          /*
           * The canvas rewrite is queued behind the attachment move, so it is still in flight when the move
           * lands. The timeout is swallowed deliberately: a canvas that never gets rewritten must be
           * reported by the content assertion below, which shows what it still says, rather than as an
           * opaque wait failure.
           */
          try {
            await waitUntil({
              message: 'the canvas file-node reference is rewritten to the attachment\'s new folder',
              predicate: async () => {
                const movedCanvasContent = await app.vault.read(movedCanvas);
                return movedCanvasContent.includes(DST_FOLDER);
              },
              timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
            });
          } catch {
            // Reported by the content assertion instead.
          }

          return {
            hasAttachmentAtNewPath: app.vault.getAbstractFileByPath(DST_ATTACHMENT) !== null,
            hasAttachmentAtOldPath: app.vault.getAbstractFileByPath(SRC_ATTACHMENT) !== null,
            movedCanvasContent: await app.vault.read(movedCanvas)
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

    // The attachment travels with the canvas rather than being left behind.
    expect(result.hasAttachmentAtNewPath).toBe(true);
    expect(result.hasAttachmentAtOldPath).toBe(false);

    // And the canvas's file-node reference names the attachment's new location.
    expect(result.movedCanvasContent).toContain('rdh-canvas-move-dst');
    expect(result.movedCanvasContent).not.toContain('rdh-canvas-move-src');
  });
});
