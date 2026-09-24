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
 * Moving a canvas whose TEXT node embeds its attachment moves the attachment, and the handler's queue drains.
 *
 * It used to hang. Collecting the canvas's attachments asks for each one's backlinks through
 * `BacklinkIndex.getBacklinksForFileSafe`, which re-reads every holder and retries until each cached reference
 * matches the holder's text. Obsidian's canvas index reports a text-node embed with a position, but that position
 * is an offset into the node's own text, not into the canvas file, so the check sliced the canvas JSON, never
 * matched, and retried forever. The attachment never moved, and every later rename or delete waited behind it in
 * this plugin's serial queue. A canvas holding only a file node escaped, because a file-node reference carries no
 * position and the check stops at it; `canvas-attachment-move.cross-platform` is that case.
 *
 * The canvas is indexed before the move, the state every real canvas is in: the canvas index is where the
 * text-node reference comes from. The move is started, not awaited, and every wait is bounded, so a regression is
 * reported by the assertions rather than as a transport timeout.
 *
 * Cross-platform: a canvas moves the same way on a phone, and the manifest declares `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface CanvasDataLike {
  readonly nodes: readonly CanvasNodeLike[];
}

interface CanvasNodeLike {
  readonly text?: string;
  readonly type: string;
}

interface CanvasTextNodeMoveResult {
  readonly hasAttachmentAtNewPath: boolean;
  readonly hasAttachmentAtOldPath: boolean;
  readonly isQueueDrained: boolean;
  readonly textNodeTargetPath: null | string;
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
 * See `settings-snapshot.integration-helper.ts`.
 */
let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('Moving a canvas whose text node embeds its attachment', () => {
  it('moves the attachment and drains the queue', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<CanvasTextNodeMoveResult> {
        const SRC_FOLDER = 'rdh-canvas-text-src';
        const DST_FOLDER = 'rdh-canvas-text-dst';
        const SRC_CANVAS = `${SRC_FOLDER}/board.canvas`;
        const DST_CANVAS = `${DST_FOLDER}/board.canvas`;
        const SRC_ATTACHMENT = `${SRC_FOLDER}/assets/img.png`;
        const DST_ATTACHMENT = `${DST_FOLDER}/assets/img.png`;
        /*
         * Under the transport's ~30s per-closure cap, not at it. `applySettings` is charged twice, at the
         * start and in the `finally`, and with {@link INDEX_TIMEOUT_IN_MILLISECONDS} and the two
         * {@link EFFECT_TIMEOUT_IN_MILLISECONDS} waits that makes 24 000 ms in total. Everything waited on here
         * lands in well under a second once the handler works.
         */
        const WAIT_TIMEOUT_IN_MILLISECONDS = 5000;
        // Measured at 50-160 ms from the canvas's creation to its entry in Obsidian's canvas index.
        const INDEX_TIMEOUT_IN_MILLISECONDS = 2000;
        const EFFECT_TIMEOUT_IN_MILLISECONDS = 6000;

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

        /**
         * Resolves the moved canvas's text-node embed the way Obsidian does.
         *
         * @returns The path the embed resolves to, or `null` when the canvas, the embed or its target is missing.
         */
        async function getTextNodeTargetPath(): Promise<null | string> {
          const movedCanvas = app.vault.getFileByPath(DST_CANVAS);
          if (!movedCanvas) {
            return null;
          }

          const canvasData = JSON.parse(await app.vault.read(movedCanvas)) as CanvasDataLike;
          const textNode = canvasData.nodes.find((node) => node.type === 'text');
          const linkpath = /!\[\[(?<linkpath>[^\]|#]+)/.exec(textNode?.text ?? '')?.groups?.['linkpath'];
          if (linkpath === undefined) {
            return null;
          }

          return app.metadataCache.getFirstLinkpathDest(linkpath, DST_CANVAS)?.path ?? null;
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

          const canvas = await app.vault.create(
            SRC_CANVAS,
            JSON.stringify(
              {
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
                  },
                  {
                    height: 100,
                    id: 'node2',
                    text: `![[${SRC_ATTACHMENT}]]`,
                    type: 'text',
                    width: 200,
                    x: 500,
                    y: 0
                  }
                ]
              },
              null,
              2
            )
          );

          const canvasIndex = app.internalPlugins.getPluginById('canvas')?.instance.index;
          if (!canvasIndex) {
            throw new Error('the Canvas core plugin is not enabled');
          }

          /*
           * `embeds` lists the file node only. The text node's reference is indexed in the same pass, measured
           * through the canvas link updater's `iterateReferences`, and that reference is the one the hang came from.
           */
          await waitUntil({
            message: 'Obsidian\'s canvas index holds the canvas and its file node',
            predicate: () => (canvasIndex.index[SRC_CANVAS]?.embeds.length ?? 0) > 0,
            timeoutInMilliseconds: INDEX_TIMEOUT_IN_MILLISECONDS
          });

          await app.fileManager.renameFile(canvas, DST_CANVAS);

          // Swallowed: an attachment that never moves is reported by the path assertions, which name where it is.
          try {
            await waitUntil({
              message: 'the embedded attachment has moved with the canvas',
              predicate: () => app.vault.getAbstractFileByPath(DST_ATTACHMENT) !== null,
              timeoutInMilliseconds: EFFECT_TIMEOUT_IN_MILLISECONDS
            });
          } catch {
            // Reported by the path assertions instead.
          }

          /*
           * Drained after the move, not before it, for the reason `canvas-partial-write-guard` gives. Awaited only
           * once it has settled: the defect is a drain that never ends.
           */
          const drainState = { isQueueDrained: false };
          const drainPromise = flushQueue().then(() => {
            drainState.isQueueDrained = true;
          });

          try {
            await waitUntil({
              message: 'the handler\'s queue drains',
              predicate: () => drainState.isQueueDrained,
              timeoutInMilliseconds: EFFECT_TIMEOUT_IN_MILLISECONDS
            });
          } catch {
            // Reported by the `isQueueDrained` assertion instead.
          }

          if (drainState.isQueueDrained) {
            await drainPromise;
          }

          return {
            hasAttachmentAtNewPath: app.vault.getAbstractFileByPath(DST_ATTACHMENT) !== null,
            hasAttachmentAtOldPath: app.vault.getAbstractFileByPath(SRC_ATTACHMENT) !== null,
            isQueueDrained: drainState.isQueueDrained,
            textNodeTargetPath: await getTextNodeTargetPath()
          };
        } finally {
          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
          await applySettings({
            shouldHandleRenames: true,
            shouldRenameAttachmentFolder: true
          });
          /*
           * Through the adapter: a fixture teardown must not travel back through the very delete path this
           * plugin patches, which would make the cleanup part of what is under test.
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

    // And nothing is left holding the queue, which every later rename or delete would wait behind.
    expect(result.isQueueDrained).toBe(true);

    // The text node's embed still resolves, now to the moved attachment.
    expect(result.textNodeTargetPath).toBe('rdh-canvas-text-dst/assets/img.png');
  });
});
