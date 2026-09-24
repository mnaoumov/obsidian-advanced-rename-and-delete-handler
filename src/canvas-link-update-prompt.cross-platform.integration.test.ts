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
 * With Obsidian's *Automatically update internal links* (`alwaysUpdateLinks`) OFF, which is Obsidian's own default,
 * a canvas link update the handler hands back to Obsidian is applied without Obsidian's *Update links* prompt.
 *
 * The handler rewrites every link of a rename it handles itself, except the ones a canvas holds or targets: those
 * it hands back to Obsidian's native `updateAllLinks`, whose canvas link updater is the one that edits a canvas
 * correctly. With the setting off that call does not update. It opens *Update links - Do you want to update
 * internal links that link to this file?* and awaits an answer. So moving a canvas raised that prompt about the
 * ATTACHMENT the handler moved with it, a file the user never touched, and until somebody answered, the
 * attachment's `renameFile` did not return and every later rename or delete waited behind it in this plugin's
 * serial queue. With `shouldHandleRenames` on, every other link is rewritten without asking, so these are too;
 * see `updateAllLinksWithoutPrompt` in `src/rename-delete-handler-component.ts`.
 *
 * The canvas is indexed before the move, the state every real canvas is in, because the prompt only comes when
 * Obsidian's canvas index holds the canvas and so finds the reference to update. The header of
 * `canvas-partial-write-guard.cross-platform.integration.test.ts` has the race that otherwise decides it.
 *
 * Cross-platform: the prompt and the queue behave the same on a phone, and the manifest declares
 * `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface CanvasPromptResult {
  readonly hasAttachmentAtNewPath: boolean;
  readonly hasAttachmentAtOldPath: boolean;
  readonly linkUpdateSourcePaths: readonly string[];
  readonly promptTexts: readonly string[];
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
 * Handed back the way the `finally` block below hands back the vault config. See
 * `settings-snapshot.integration-helper.ts`.
 */
let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('Moving a canvas with alwaysUpdateLinks off', () => {
  it('updates the canvas link to the moved attachment without the Update links prompt', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<CanvasPromptResult> {
        const SRC_FOLDER = 'rdh-canvas-prompt-src';
        const DST_FOLDER = 'rdh-canvas-prompt-dst';
        const SRC_CANVAS = `${SRC_FOLDER}/board.canvas`;
        const DST_CANVAS = `${DST_FOLDER}/board.canvas`;
        const SRC_ATTACHMENT = `${SRC_FOLDER}/assets/img.png`;
        const DST_ATTACHMENT = `${DST_FOLDER}/assets/img.png`;
        /*
         * Under the transport's ~30s per-closure cap, not at it. `applySettings` is charged twice, at the
         * start and in the `finally`, and with {@link INDEX_TIMEOUT_IN_MILLISECONDS}, the two
         * {@link EFFECT_TIMEOUT_IN_MILLISECONDS} waits and {@link CLOSE_TIMEOUT_IN_MILLISECONDS} that makes
         * 26 000 ms in total. Everything waited on here lands in well under a second.
         */
        const WAIT_TIMEOUT_IN_MILLISECONDS = 5000;
        // Measured at 50-160 ms from the canvas's creation to its entry in Obsidian's canvas index.
        const INDEX_TIMEOUT_IN_MILLISECONDS = 2000;
        const EFFECT_TIMEOUT_IN_MILLISECONDS = 6000;
        // A modal's close animation, which takes a few hundred milliseconds.
        const CLOSE_TIMEOUT_IN_MILLISECONDS = 2000;

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

        const promptTexts: string[] = [];
        const dismissedModalEls = new WeakSet<Element>();

        /**
         * Records and dismisses every modal on screen, so a prompt that does appear is reported by the
         * assertions rather than left holding the queue, and with it every suite after this one.
         */
        function dismissPrompts(): void {
          for (const modalEl of document.querySelectorAll('.modal-container')) {
            // A closed modal stays in the DOM while it animates out, so each one is recorded and closed once.
            if (dismissedModalEls.has(modalEl)) {
              continue;
            }

            dismissedModalEls.add(modalEl);
            promptTexts.push(modalEl.textContent);
            // The prompt's last button, *Don't update*; any other modal's close button.
            const dismissButtonEl = modalEl.querySelector<HTMLElement>(':scope .modal-button-container button:last-child')
              ?? modalEl.querySelector<HTMLElement>('.modal-close-button');
            dismissButtonEl?.click();
          }
        }

        /*
         * Every source file Obsidian's link update actually rewrites. `fileManager.updateAllLinks` reaches
         * `metadataCache.updateInternalLinks` only once the update is confirmed, by the setting or by a click, so
         * the canvas appearing here is the update being APPLIED rather than declined. The canvas's content
         * cannot show it: Obsidian's canvas updater rewrites text nodes only, and a file node is re-pointed by
         * the canvas plugin on its own schedule. Shadowed with an own property, which the `finally` removes
         * again, so the next suite on this shared instance meets the metadata cache untouched.
         */
        const linkUpdateSourcePaths: string[] = [];
        const metadataCache = app.metadataCache;
        const hasOwnUpdateInternalLinks = Object.hasOwn(metadataCache, 'updateInternalLinks');
        const originalUpdateInternalLinks = metadataCache.updateInternalLinks;
        Object.assign(metadataCache, {
          updateInternalLinks(this: unknown, ...updateArguments: Parameters<typeof originalUpdateInternalLinks>): Promise<void> {
            linkUpdateSourcePaths.push(...updateArguments[0].keys());
            return originalUpdateInternalLinks.apply(this, updateArguments);
          }
        });

        const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');
        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          app.vault.setConfig('attachmentFolderPath', './assets');
          // Obsidian's own default, which the harness overrides for every run: the case under test.
          app.vault.setConfig('alwaysUpdateLinks', false);

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

          await waitUntil({
            message: 'Obsidian\'s canvas index holds the canvas and its file node',
            predicate: () => (canvasIndex.index[SRC_CANVAS]?.embeds.length ?? 0) > 0,
            timeoutInMilliseconds: INDEX_TIMEOUT_IN_MILLISECONDS
          });

          /*
           * Started, not awaited, and every wait below dismisses any modal it sees. A prompt holds the
           * `renameFile` that raised it until somebody answers, so awaiting the rename, or the attachment move
           * that follows it, would hang on the very defect this suite exists to report. Measured without the
           * fix: the canvas's own rename prompts, so a plain `await` never returns.
           */
          let isRenamed = false;
          const renamePromise = app.fileManager.renameFile(canvas, DST_CANVAS).then(() => {
            isRenamed = true;
          });

          // Swallowed: an attachment that never moves is reported by the path assertions, which name where it is.
          try {
            await waitUntil({
              message: 'the canvas rename returns and the embedded attachment has moved with it',
              predicate: () => {
                dismissPrompts();
                return isRenamed && app.vault.getAbstractFileByPath(DST_ATTACHMENT) !== null;
              },
              timeoutInMilliseconds: EFFECT_TIMEOUT_IN_MILLISECONDS
            });
          } catch {
            // Reported by the path assertions instead.
          }

          await renamePromise;

          /*
           * The attachment lands BEFORE its own prompt would open: Obsidian renames the file and only then
           * runs `updateAllLinks`, which is where the prompt comes from. So the drain dismisses modals too.
           * Drained after the move, not before it, for the reason `canvas-partial-write-guard` gives.
           */
          let isQueueDrained = false;
          const drainPromise = flushQueue().then(() => {
            isQueueDrained = true;
          });

          await waitUntil({
            message: 'the handler\'s queue drains',
            predicate: () => {
              dismissPrompts();
              return isQueueDrained;
            },
            timeoutInMilliseconds: EFFECT_TIMEOUT_IN_MILLISECONDS
          });
          await drainPromise;

          return {
            hasAttachmentAtNewPath: app.vault.getAbstractFileByPath(DST_ATTACHMENT) !== null,
            hasAttachmentAtOldPath: app.vault.getAbstractFileByPath(SRC_ATTACHMENT) !== null,
            linkUpdateSourcePaths,
            promptTexts
          };
        } finally {
          if (hasOwnUpdateInternalLinks) {
            Object.assign(metadataCache, { updateInternalLinks: originalUpdateInternalLinks });
          } else {
            Reflect.deleteProperty(metadataCache, 'updateInternalLinks');
          }
          /*
           * The settings dialog `applySettings` looks for must not be mistaken for a prompt still animating out,
           * or for the next prompt, which dismissing the one before it lets the held move reach.
           */
          await waitUntil({
            message: 'every prompt is dismissed and has left the screen',
            predicate: () => {
              dismissPrompts();
              return document.querySelector('.modal-container') === null;
            },
            timeoutInMilliseconds: CLOSE_TIMEOUT_IN_MILLISECONDS
          });
          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
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

    expect(result.hasAttachmentAtNewPath).toBe(true);
    expect(result.hasAttachmentAtOldPath).toBe(false);

    // No prompt, about the canvas the user moved or the attachment the handler moved with it.
    expect(result.promptTexts).toEqual([]);

    // And Obsidian still applied the canvas's link update: the prompt was answered, not the update declined.
    expect(result.linkUpdateSourcePaths).toContain('rdh-canvas-prompt-dst/board.canvas');
  });
});
