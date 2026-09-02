import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * Moving a note leaves EVERY embed in it pointing at a real file, however many attachments it has.
 *
 * See https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/60 ("The image link is not
 * updated"). The reporter's only usable observation was a scale threshold — few images rewrite fine, many
 * leave "some image references ... while others will not change" — so the same scenario runs here at two
 * sizes, 3 and 30.
 *
 * In `obsidian-custom-attachment-location` this suite did NOT reproduce the defect — nothing edited the note
 * between the snapshot and the rewrite there, so no offset ever drifted and the fragile lookup always hit.
 * That is no longer true in this shape, and it was measured rather than assumed: with `getLinkIdentityKey`
 * replaced by a position-bearing key, BOTH sizes fail here, all three embeds stale at 3 and all thirty at 30
 * (2026-09-02). Moving the note to a much longer destination folder makes the very first rewrite shift every
 * link after it, which is enough on its own — no second party required. So this suite pins the defect
 * directly, and its sibling `note-move-concurrent-edit.desktop.integration.test.ts` pins the reporter's own
 * route to it, an outside edit landing inside the rename window.
 *
 * Two vault settings are deliberate, because with the defaults the scenario could not exhibit the defect even
 * in principle and would be green for a second, wrong reason:
 *   - `newLinkFormat: 'absolute'` — with the default shortest-path format every rewritten link is just the
 *     bare file name, identical before and after the move, so no offsets shift.
 *   - the destination folder name is LONGER than the source's — the folder is part of every link under the
 *     absolute format, so a length change is what makes each rewrite shift the links after it.
 *
 * Ported from `obsidian-custom-attachment-location`, which deleted the suite when it stopped registering a
 * rename/delete handler. Rewritten rather than copied: the original assigned to a settings object it found by
 * walking the plugin's component tree and used that plugin's per-note `./assets/${noteFileName}` attachment
 * folder, while here settings go in through this plugin's `migrateSettings` API — its only public write path
 * — and the attachments sit in Obsidian's own shared `./assets` folder, which is what makes MOVING the note
 * to another folder the operation that relocates them. Each case repeats its own settings helper because an
 * `evalInObsidian` callback is serialized and reaches nothing outside itself.
 *
 * Desktop-only: the link rewrite it guards is platform-independent, and the owner's call was to keep the
 * heavy timing-sensitive suites — this one, its sibling, and the folder-swap replay — off the Android
 * emulator pass, where a stale run costs far more than it proves. The light rename suites stay
 * cross-platform.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';
const ATTACHMENT_COUNTS = [3, 30];
const SCENARIO_TIMEOUT_IN_MILLISECONDS = 180_000;

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

interface NoteMoveResult {
  readonly movedAttachmentCount: number;
  readonly noteContentAfter: string;
  readonly staleLinks: readonly string[];
  readonly totalLinkCount: number;
}

interface PluginWithApiLike {
  readonly api: MigrationApiLike;
}

describe('Moving a note with attachments', () => {
  for (const attachmentCount of ATTACHMENT_COUNTS) {
    it(`keeps every one of its ${attachmentCount.toString()} embeds resolving`, async () => {
      const result = await evalInObsidian({
        async callback({
          app,
          attachmentCount: count,
          lib: {
            flushQueue,
            waitUntil
          },
          pluginId,
          sourcePluginId
        }): Promise<NoteMoveResult> {
          const SRC_FOLDER = `rdh-note-move-${count.toString()}-src`;
          // Deliberately longer than the source, so every rewritten link grows and the links after it shift.
          const DST_FOLDER = `rdh-note-move-${count.toString()}-destination-with-a-much-longer-name`;
          const SRC_NOTE = `${SRC_FOLDER}/note.md`;
          const DST_NOTE = `${DST_FOLDER}/note.md`;
          const SRC_ATTACHMENT_FOLDER = `${SRC_FOLDER}/assets`;
          const DST_ATTACHMENT_FOLDER = `${DST_FOLDER}/assets`;
          const WAIT_TIMEOUT_IN_MILLISECONDS = 60_000;

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

          // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
          try {
            app.vault.setConfig('attachmentFolderPath', './assets');
            // Obsidian otherwise asks for confirmation through a modal, which would stall a headless run.
            app.vault.setConfig('alwaysUpdateLinks', true);
            // See the file header: the default shortest-path format would leave every rewritten link textually identical.
            app.vault.setConfig('newLinkFormat', 'absolute');

            // The plugin's own defaults, stated so the scenario cannot silently drift with them.
            await applySettings({
              shouldHandleRenames: true,
              shouldRenameAttachmentFolder: true
            });

            await app.vault.createFolder(SRC_ATTACHMENT_FOLDER);
            await app.vault.createFolder(DST_FOLDER);

            const noteLines: string[] = [];
            for (let index = 0; index < count; index++) {
              const attachmentPath = `${SRC_ATTACHMENT_FOLDER}/img-${index.toString().padStart(3, '0')}.png`;
              await app.vault.createBinary(attachmentPath, new ArrayBuffer(8));
              noteLines.push(`Image ${index.toString()}: ![[${attachmentPath}]]`);
            }

            const note = await app.vault.create(SRC_NOTE, `${noteLines.join('\n\n')}\n`);

            /*
             * The handler builds its rewrite plan from the metadata cache, so a half-resolved note would
             * under-report the defect.
             */
            await waitUntil({
              message: 'every embed in the note is indexed by the metadata cache',
              predicate: () => (app.metadataCache.getFileCache(note)?.embeds?.length ?? 0) >= count,
              timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
            });

            await app.fileManager.renameFile(note, DST_NOTE);
            // The handler moves the attachments and rewrites the links on its own queue, which this drains.
            await flushQueue();

            await waitUntil({
              message: 'every attachment has moved into the destination folder',
              predicate: () => countMovedAttachments() >= count,
              timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
            });

            const movedNote = app.vault.getFileByPath(DST_NOTE);
            if (!movedNote) {
              throw new Error(`Note ${DST_NOTE} not found.`);
            }

            /*
             * The timeout is swallowed deliberately: a link left stale must be reported by the assertion
             * below, which names WHICH links went stale — their identity is the evidence for the
             * position-drift mechanism — rather than as an opaque wait failure.
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
             * Whether the link still points at a file is the whole of what the issue reports.
             *
             * @param content - The note's content.
             * @returns The link paths that resolve to nothing.
             */
            function collectStaleLinks(content: string): string[] {
              return collectLinkPaths(content).filter((linkPath) => !app.metadataCache.getFirstLinkpathDest(linkPath, DST_NOTE));
            }
          } finally {
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
          attachmentCount,
          pluginId: PLUGIN_ID,
          sourcePluginId: SOURCE_PLUGIN_ID
        }
      });

      /*
       * The scenario staged what it claims to: the note kept all its embeds and every attachment followed
       * it. Without these, an empty stale-link list would prove nothing.
       */
      expect(result.totalLinkCount).toBe(attachmentCount);
      expect(result.movedAttachmentCount).toBe(attachmentCount);

      /*
       * Every embed must still resolve. Asserted on the whole list rather than a count, so a partial failure
       * NAMES the links that went stale — which of them fail is the evidence for the position-drift
       * mechanism, the broken build failing with exactly the tail of the note.
       */
      expect(result.staleLinks).toStrictEqual([]);
    }, SCENARIO_TIMEOUT_IN_MILLISECONDS);
  }
});
