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
 * Moving a note leaves every embed in it resolving EVEN IF something else edits the note while the move is
 * in flight.
 *
 * See https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/60 ("The image link is not
 * updated"). This suite pins the reporter's own route to the defect: the one field they did fill in was
 * "only with other plugins enabled", so what is staged here is that second plugin. (Its sibling
 * `note-move-many-attachments.desktop.integration.test.ts` reaches the same defect without one — see its
 * header for the measurement — so the two are complementary rather than duplicates.)
 *
 * The second party is supplied in the smallest deterministic way there is. From inside the vault
 * `rename` event of the first attachment move — precisely the window between `RenameMap.initBacklinksMap()`
 * snapshotting its link keys and `editLinks()` looking them up against the live metadata cache — it inserts a
 * line in the MIDDLE of the note, shifting the offsets of every link below it and leaving the ones above
 * untouched.
 *
 * The defect: the snapshot was keyed on the whole `Reference`, `position` included. A shifted link missed its
 * key and hit a silent `return` — no error, no retry — so it kept pointing at the attachment's old path while
 * the links above the edit were rewritten correctly. Hence "some image references will change ... while
 * others will not change". `getLinkIdentityKey` in `src/rename-delete-handler-component.ts` is the fix this
 * pins: it keys on the link's TEXT and deliberately not on its position.
 *
 * The MIDDLE insertion is load-bearing, not incidental: it is what distinguishes this defect from a
 * whole-file bail-out (the rewrite refusing the file outright when its content changed underneath), which
 * would lose ALL the links rather than a contiguous tail.
 *
 * Ported from `obsidian-custom-attachment-location`, which deleted the suite when it stopped registering a
 * rename/delete handler. Rewritten rather than copied, for the reasons set out in the sibling suite's header:
 * settings go in through this plugin's `migrateSettings` API, and the attachments sit in Obsidian's own
 * shared `./assets` folder, so MOVING the note to another folder is what relocates them.
 *
 * Desktop-only, as its sibling is: the behavior is platform-independent, and the owner's call was to keep
 * the heavy timing-sensitive suites off the Android emulator pass.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';
const ATTACHMENT_COUNT = 30;
const SCENARIO_TIMEOUT_IN_MILLISECONDS = 180_000;

interface ConcurrentEditResult {
  readonly isEditApplied: boolean;
  readonly movedAttachmentCount: number;
  readonly noteContentAfter: string;
  readonly staleLinks: readonly string[];
  readonly totalLinkCount: number;
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

describe('A note edited by another plugin while it is being moved', () => {
  it('still has every one of its embeds resolving', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        attachmentCount,
        lib: {
          flushQueue,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<ConcurrentEditResult> {
        const SRC_FOLDER = 'rdh-note-move-edit-src';
        // Deliberately longer than the source, so every rewritten link grows and the links after it shift.
        const DST_FOLDER = 'rdh-note-move-edit-destination-with-a-much-longer-name';
        const SRC_NOTE = `${SRC_FOLDER}/note.md`;
        const DST_NOTE = `${DST_FOLDER}/note.md`;
        const SRC_ATTACHMENT_FOLDER = `${SRC_FOLDER}/assets`;
        const DST_ATTACHMENT_FOLDER = `${DST_FOLDER}/assets`;
        const WAIT_TIMEOUT_IN_MILLISECONDS = 60_000;
        const INSERTED_LINE = 'A line inserted mid-rename to shift the offsets after it.';

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

        /**
         * Counts the attachments that have arrived in the destination note's attachment folder.
         *
         * @returns The count.
         */
        function countMovedAttachments(): number {
          return app.vault.getFiles().filter((file) => file.path.startsWith(`${DST_ATTACHMENT_FOLDER}/`)).length;
        }

        const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');
        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');
        const originalNewLinkFormat = app.vault.getConfig('newLinkFormat');

        let isEditApplied = false;
        let renameEventRef: null | ReturnType<typeof app.vault.on> = null;

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          app.vault.setConfig('attachmentFolderPath', './assets');
          // Obsidian otherwise asks for confirmation through a modal, which would stall a headless run.
          app.vault.setConfig('alwaysUpdateLinks', true);
          // See the file header: the default shortest-path format would leave every rewritten link textually identical.
          app.vault.setConfig('newLinkFormat', 'absolute');

          await applySettings({
            shouldHandleRenames: true,
            shouldRenameAttachmentFolder: true
          });

          await app.vault.createFolder(SRC_ATTACHMENT_FOLDER);
          await app.vault.createFolder(DST_FOLDER);

          const noteLines: string[] = [];
          for (let index = 0; index < attachmentCount; index++) {
            const attachmentPath = `${SRC_ATTACHMENT_FOLDER}/img-${index.toString().padStart(3, '0')}.png`;
            await app.vault.createBinary(attachmentPath, new ArrayBuffer(8));
            noteLines.push(`Image ${index.toString()}: ![[${attachmentPath}]]`);
          }

          const note = await app.vault.create(SRC_NOTE, `${noteLines.join('\n\n')}\n`);

          await waitUntil({
            message: 'every embed in the note is indexed by the metadata cache',
            predicate: () => (app.metadataCache.getFileCache(note)?.embeds?.length ?? 0) >= attachmentCount,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          /*
           * The emulated second plugin. It fires on the FIRST attachment rename — which happens after the
           * handler has snapshotted its link keys and before it rewrites them — and inserts a line halfway
           * down the note, shifting every link below it. A real co-installed link-rewriting plugin perturbs
           * the same window; this is the minimal deterministic stand-in for one.
           */
          renameEventRef = app.vault.on('rename', (file) => {
            if (isEditApplied || !file.path.startsWith(`${DST_ATTACHMENT_FOLDER}/`)) {
              return;
            }

            isEditApplied = true;
            const noteFile = app.vault.getFileByPath(DST_NOTE) ?? app.vault.getFileByPath(SRC_NOTE);
            if (!noteFile) {
              return;
            }

            app.vault.process(noteFile, (content) => {
              const blocks = content.split('\n\n');
              const insertAt = Math.floor(blocks.length / 2);
              return [...blocks.slice(0, insertAt), INSERTED_LINE, ...blocks.slice(insertAt)].join('\n\n');
            }).catch(() => {
              /*
               * The vault `rename` callback is synchronous, so this edit is fire-and-forget. A failure is not
               * swallowed silently: `isEditApplied` is asserted below, and the suite is meaningless without it.
               */
            });
          });

          await app.fileManager.renameFile(note, DST_NOTE);
          // The handler moves the attachments and rewrites the links on its own queue, which this drains.
          await flushQueue();

          await waitUntil({
            message: 'every attachment has moved into the destination folder',
            predicate: () => countMovedAttachments() >= attachmentCount,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const movedNote = app.vault.getFileByPath(DST_NOTE);
          if (!movedNote) {
            throw new Error(`Note ${DST_NOTE} not found.`);
          }

          /*
           * The timeout is swallowed deliberately: a link left stale must be reported by the assertion below,
           * which names WHICH links went stale — the broken build fails with exactly the contiguous tail
           * after the insertion point, and that identity is the evidence for the mechanism — rather than as
           * an opaque wait failure.
           */
          try {
            await waitUntil({
              message: 'every embed in the moved note resolves again',
              predicate: async () => collectStaleLinks(await app.vault.read(movedNote)).length === 0,
              timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
            });
          } catch {
            // Reported by the stale-link assertion instead.
          }

          const noteContentAfter = await app.vault.read(movedNote);
          return {
            isEditApplied,
            movedAttachmentCount: countMovedAttachments(),
            noteContentAfter,
            staleLinks: collectStaleLinks(noteContentAfter),
            totalLinkCount: collectLinkPaths(noteContentAfter).length
          };

          /**
           * Reads the embed targets out of the note's text.
           *
           * @param content - The note's content.
           * @returns The link paths, in the order they appear.
           */
          function collectLinkPaths(content: string): string[] {
            return [...content.matchAll(/!\[\[(?<linkPath>[^\]|]+)/g)]
              .map((match) => match.groups?.['linkPath']?.trim() ?? '')
              .filter((linkPath) => linkPath !== '');
          }

          /**
           * Picks out the embeds that no longer resolve to a file.
           *
           * Asked of the metadata cache rather than matched as text: Obsidian rewrites using the vault's
           * configured link format, so a correct rewrite can legitimately come back in a different shape.
           *
           * @param content - The note's content.
           * @returns The link paths that resolve to nothing.
           */
          function collectStaleLinks(content: string): string[] {
            return collectLinkPaths(content).filter((linkPath) => !app.metadataCache.getFirstLinkpathDest(linkPath, DST_NOTE));
          }
        } finally {
          if (renameEventRef) {
            app.vault.offref(renameEventRef);
          }

          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
          app.vault.setConfig('newLinkFormat', originalNewLinkFormat);
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
        attachmentCount: ATTACHMENT_COUNT,
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    /*
     * The emulated second plugin really did edit the note inside the rename window. Without this the suite
     * would silently degrade into a duplicate of the plain scale suite and prove nothing.
     */
    expect(result.isEditApplied).toBe(true);
    expect(result.noteContentAfter).toContain('A line inserted mid-rename');

    // The scenario staged what it claims to: the note kept all its embeds and every attachment moved.
    expect(result.totalLinkCount).toBe(ATTACHMENT_COUNT);
    expect(result.movedAttachmentCount).toBe(ATTACHMENT_COUNT);

    // Every embed must still resolve, named individually so a regression shows which of them went stale.
    expect(result.staleLinks).toStrictEqual([]);
  }, SCENARIO_TIMEOUT_IN_MILLISECONDS);
});
