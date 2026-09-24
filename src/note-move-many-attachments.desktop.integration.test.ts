import {
  ContextId,
  evalInObsidian,
  pollInObsidian
} from 'obsidian-integration-testing';
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
 * to another folder the operation that relocates them. Each closure repeats whatever it needs, because an
 * `evalInObsidian` callback is serialized and reaches nothing outside itself.
 *
 * Desktop-only: the link rewrite it guards is platform-independent, and the owner's call was to keep the
 * heavy timing-sensitive suites — this one, its sibling, and the folder-swap replay — off the Android
 * emulator pass, where a stale run costs far more than it proves. The light rename suites stay
 * cross-platform.
 *
 * ## The waiting happens in NODE, and no ceiling could have replaced that
 *
 * This scenario used to be ONE `evalInObsidian` closure declaring four 60 000 ms `waitUntil` calls — 240 000
 * ms of waiting inside a single `Runtime.evaluate`. A whole closure is one transport call, so that budget was
 * honoured by nothing: the desktop project's raised `commandTimeoutInMilliseconds` is itself 240 000, and the
 * test's own vitest timeout was 180 000, so the declared worst case could not be reached under either bound.
 * Lowering the ceilings instead was considered and refused — a 30-attachment move plus the handler's queue
 * drain can genuinely take minutes on a cold or loaded machine, which is why the ceilings were that size in
 * the first place, so any number small enough to fit one transport call is a number a legitimate slow run
 * fails at.
 *
 * So the long waits moved to Node, one short `poll` at a time, and the budgets below are now real: the three
 * of them plus the settings dialog sum to under this test's own timeout, which is the first time those two
 * numbers have agreed.
 *
 * **What that changes about the scenario, stated because it is a real change and not a refactor.** The old
 * shape awaited `renameFile` and then `flushQueue()` straight afterwards, as its proof that the move had
 * finished. Awaiting the rename cannot cross the transport boundary without putting the whole operation back
 * inside one call, so the rename is now FIRED, and the polls are what prove the OBSERVABLE effects arrived:
 * first that every attachment has reached the destination folder, then that every embed resolves again. A
 * rename that REJECTS has nowhere to surface once it is not awaited, so `start` stashes the rejection in the
 * shared `context` and `poll` reports it — which is what the `contextId` parameter is for, and it is the
 * only state here that cannot be re-derived from a path.
 *
 * **`flushQueue()` did NOT go away, and the first draft of this conversion was wrong to drop it.** Effects
 * arriving is not the same as the queue being empty, and one run drives every suite against one Obsidian
 * instance — so work still in flight when this test's `finally` removes its folders becomes the NEXT suite's
 * problem. Measured: with the drain dropped, the desktop aggregate failed two runs out of two, each time in
 * a different innocent suite reading a half-written file, against three green runs on the unchanged branch.
 * So the drain stays; it simply happens where this repo's own rule has always said to put it — AFTER the
 * effect being waited for, not on the line after the rename — and by then what is left to drain is tail
 * work that fits inside one transport call.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';
const ATTACHMENT_COUNTS = [3, 30];
const SCENARIO_TIMEOUT_IN_MILLISECONDS = 180_000;

/*
 * Under the transport's ~30s per-closure cap, not at it. This is the one closure here that still waits
 * in-page, because what it waits on cannot cross the boundary: a live `migrateSettings` promise and the
 * `isSettled` flag its handlers set. It is a settings write and a modal, which settle in well under a second,
 * so it is the whole of this file's in-closure budget.
 */
const SETTINGS_WAIT_TIMEOUT_IN_MILLISECONDS = 8000;

/**
 * The Node-side budget for the created embeds to reach the metadata cache.
 */
const INDEX_TIMEOUT_IN_MILLISECONDS = 30_000;

/**
 * The Node-side budget for the handler to carry every attachment into the destination folder.
 *
 * The long one, because this is the step the issue is about: thirty attachments moved one at a time through
 * the plugin's own operation queue. Safe to be long because Node does the waiting.
 */
const MOVE_TIMEOUT_IN_MILLISECONDS = 90_000;

/**
 * The Node-side budget for the rewritten links to settle.
 */
const REWRITE_TIMEOUT_IN_MILLISECONDS = 45_000;

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

/**
 * What the move poll reports back to Node.
 */
interface MoveProbe {
  readonly movedAttachmentCount: number;

  /**
   * The message of the rejection the fired rename produced, or `null` while it has not rejected.
   *
   * The rename is deliberately not awaited, so this is the only route a genuine failure has back to Node —
   * without it a rejected rename reads as an attachment count that never rises.
   */
  readonly renameError: null | string;
}

/**
 * The state `start` leaves for `poll`, shared through the call's {@link ContextId}.
 */
interface NoteMoveContext {
  renameError?: string;
}

interface NoteMoveResult {
  readonly movedAttachmentCount: number;
  readonly noteContentAfter: string;
  readonly staleLinks: readonly string[];
  readonly totalLinkCount: number;
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

/**
 * The three vault configs this scenario overwrites, carried back to Node so the restore is a Node-side
 * `finally` that runs however the scenario ends.
 */
interface VaultConfigSnapshot {
  readonly alwaysUpdateLinks: unknown;
  readonly attachmentFolderPath: unknown;
  readonly newLinkFormat: unknown;
}

/*
 * This plugin's settings outlive each test file — one run drives every suite against one Obsidian instance —
 * so what this suite stages must not become the starting point of whichever file the sequencer runs next.
 * Handed back the way the Node-side `finally` below hands back the vault configs. See
 * `settings-snapshot.integration-helper.ts`.
 */
let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('Moving a note with attachments', () => {
  for (const attachmentCount of ATTACHMENT_COUNTS) {
    it(`keeps every one of its ${attachmentCount.toString()} embeds resolving`, async () => {
      const SRC_FOLDER = `rdh-note-move-${attachmentCount.toString()}-src`;
      // Deliberately longer than the source, so every rewritten link grows and the links after it shift.
      const DST_FOLDER = `rdh-note-move-${attachmentCount.toString()}-destination-with-a-much-longer-name`;
      const SRC_NOTE = `${SRC_FOLDER}/note.md`;
      const DST_NOTE = `${DST_FOLDER}/note.md`;
      const SRC_ATTACHMENT_FOLDER = `${SRC_FOLDER}/assets`;
      const DST_ATTACHMENT_FOLDER = `${DST_FOLDER}/assets`;

      const contextId = new ContextId<NoteMoveContext>();
      const originalConfigs = await stageVaultConfigs();

      try {
        await applySettings();
        await createFixture();
        await waitForEmbedsToIndex();
        await moveNote();
        await waitForLinksToSettle();

        const result = await readResult();

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
      } finally {
        await drainQueue();
        await restore(originalConfigs);
        await contextId.dispose();
      }

      /**
       * Drains whatever is left on the handler's own operation queue.
       *
       * This is the `flushQueue()` the pre-conversion shape awaited on the line after the rename, where it
       * covered the whole move; here it runs once the polls above have already proven the move's effects
       * arrived, so what is left is tail work and the call is short. It is not optional bookkeeping — see the
       * file header for what dropping it cost — and it runs from the `finally` so a failed assertion cannot
       * hand a live queue to the next suite.
       *
       * A rejection is swallowed: this runs on the failure path too, and a stuck queue must not replace the
       * assertion that actually failed.
       */
      async function drainQueue(): Promise<void> {
        try {
          await evalInObsidian({
            async callback({ lib: { flushQueue } }): Promise<void> {
              await flushQueue();
            }
          });
        } catch {
          // Reported by whatever the scenario itself found, which is the more useful failure.
        }
      }

      /**
       * Writes the plugin's own defaults through its migration API and approves the dialog that raises.
       *
       * Stated explicitly rather than left to the defaults, so the scenario cannot silently drift with them.
       * A proposal that matches what the plugin already holds resolves with no dialog at all, so the wait
       * settles on either outcome rather than insisting on a modal that may never appear.
       */
      async function applySettings(): Promise<void> {
        await evalInObsidian({
          async callback({
            lib: { waitUntil },
            pluginId,
            sourcePluginId,
            waitTimeoutInMilliseconds
          }): Promise<void> {
            const apiRecord = (window as PluginApiRegistryHostLike).__obsidianDevUtils?.pluginApiRegistry?.value?.records?.[pluginId]
              ?.find((candidate) => !candidate.isRevoked);
            if (!apiRecord) {
              throw new Error(`${pluginId} has published no API`);
            }

            const api = apiRecord.api;

            const migrationPromise = api.migrateSettings({
              proposedSettings: {
                shouldHandleRenames: true,
                shouldRenameAttachmentFolder: true
              },
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
              timeoutInMilliseconds: waitTimeoutInMilliseconds
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
          },
          input: {
            pluginId: PLUGIN_ID,
            sourcePluginId: SOURCE_PLUGIN_ID,
            waitTimeoutInMilliseconds: SETTINGS_WAIT_TIMEOUT_IN_MILLISECONDS
          }
        });
      }

      /**
       * Builds the source tree: the attachment folder, the destination folder, the attachments, and the note
       * embedding every one of them.
       */
      async function createFixture(): Promise<void> {
        await evalInObsidian({
          async callback({
            app,
            count,
            destinationFolder,
            srcAttachmentFolder,
            srcNote
          }): Promise<void> {
            await app.vault.createFolder(srcAttachmentFolder);
            await app.vault.createFolder(destinationFolder);

            const noteLines: string[] = [];
            for (let index = 0; index < count; index++) {
              const attachmentPath = `${srcAttachmentFolder}/img-${index.toString().padStart(3, '0')}.png`;
              await app.vault.createBinary(attachmentPath, new ArrayBuffer(8));
              noteLines.push(`Image ${index.toString()}: ![[${attachmentPath}]]`);
            }

            await app.vault.create(srcNote, `${noteLines.join('\n\n')}\n`);
          },
          input: {
            count: attachmentCount,
            destinationFolder: DST_FOLDER,
            srcAttachmentFolder: SRC_ATTACHMENT_FOLDER,
            srcNote: SRC_NOTE
          }
        });
      }

      /**
       * Fires the rename and waits, from Node, for every attachment to arrive in the destination folder.
       *
       * `start` does NOT await the rename: awaiting it would put the whole move — the very thing that can run
       * for minutes — back inside one transport call. The attachment count arriving is the proof the queue
       * ran, in place of the `flushQueue()` the old shape awaited here.
       */
      async function moveNote(): Promise<void> {
        const probe = await pollInObsidian({
          contextId,
          input: {
            destinationAttachmentFolder: DST_ATTACHMENT_FOLDER,
            destinationNote: DST_NOTE,
            srcNote: SRC_NOTE
          },
          poll({ app, context, destinationAttachmentFolder }): MoveProbe {
            return {
              movedAttachmentCount: app.vault.getFiles().filter((file) => file.path.startsWith(`${destinationAttachmentFolder}/`)).length,
              renameError: context.renameError ?? null
            };
          },
          start({ app, context, destinationNote, srcNote }): void {
            const note = app.vault.getFileByPath(srcNote);
            if (!note) {
              throw new Error(`Note ${srcNote} not found.`);
            }

            app.fileManager.renameFile(note, destinationNote).catch((error: unknown) => {
              context.renameError = error instanceof Error ? error.message : String(error);
            });
          },
          timeoutInMilliseconds: MOVE_TIMEOUT_IN_MILLISECONDS,
          timeoutMessage: 'the attachments never finished moving into the destination folder',
          until: (result: MoveProbe): boolean => result.renameError !== null || result.movedAttachmentCount >= attachmentCount
        });

        if (probe.renameError !== null) {
          throw new Error(`the rename rejected: ${probe.renameError}`);
        }
      }

      /**
       * Reads what the move left behind.
       *
       * @returns The moved note's content, its embeds, and which of them resolve to nothing.
       */
      async function readResult(): Promise<NoteMoveResult> {
        return await evalInObsidian({
          async callback({
            app,
            destinationAttachmentFolder,
            destinationNote
          }): Promise<NoteMoveResult> {
            const movedNote = app.vault.getFileByPath(destinationNote);
            if (!movedNote) {
              throw new Error(`Note ${destinationNote} not found.`);
            }

            const noteContentAfter = await app.vault.read(movedNote);
            return {
              movedAttachmentCount: app.vault.getFiles().filter((file) => file.path.startsWith(`${destinationAttachmentFolder}/`)).length,
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
              return collectLinkPaths(content).filter((linkPath) => !app.metadataCache.getFirstLinkpathDest(linkPath, destinationNote));
            }
          },
          input: {
            destinationAttachmentFolder: DST_ATTACHMENT_FOLDER,
            destinationNote: DST_NOTE
          }
        });
      }

      /**
       * Puts the vault configs back and removes the two folders this scenario created.
       *
       * Runs from a Node-side `finally`, so it happens however the scenario ends — a timed-out poll included.
       *
       * @param configs - What {@link stageVaultConfigs} read before overwriting them.
       */
      async function restore(configs: VaultConfigSnapshot): Promise<void> {
        await evalInObsidian({
          async callback({
            alwaysUpdateLinks,
            app,
            attachmentFolderPath,
            folderPaths,
            newLinkFormat
          }): Promise<void> {
            app.vault.setConfig('attachmentFolderPath', attachmentFolderPath);
            app.vault.setConfig('alwaysUpdateLinks', alwaysUpdateLinks);
            app.vault.setConfig('newLinkFormat', newLinkFormat);
            /*
             * Through the adapter, as the conflicting-plugin suite does: a fixture teardown must not travel
             * back through the very delete path this plugin patches, which would make the cleanup part of
             * what is under test.
             */
            for (const folderPath of folderPaths) {
              if (await app.vault.adapter.exists(folderPath)) {
                await app.vault.adapter.rmdir(folderPath, true);
              }
            }
          },
          input: {
            alwaysUpdateLinks: configs.alwaysUpdateLinks,
            attachmentFolderPath: configs.attachmentFolderPath,
            folderPaths: [SRC_FOLDER, DST_FOLDER],
            newLinkFormat: configs.newLinkFormat
          }
        });
      }

      /**
       * Reads the three vault configs this scenario overwrites, and overwrites them.
       *
       * @returns What was there before, for {@link restore}.
       */
      async function stageVaultConfigs(): Promise<VaultConfigSnapshot> {
        return await evalInObsidian({
          callback({ app }): VaultConfigSnapshot {
            const snapshot: VaultConfigSnapshot = {
              alwaysUpdateLinks: app.vault.getConfig('alwaysUpdateLinks'),
              attachmentFolderPath: app.vault.getConfig('attachmentFolderPath'),
              newLinkFormat: app.vault.getConfig('newLinkFormat')
            };

            app.vault.setConfig('attachmentFolderPath', './assets');
            // Obsidian otherwise asks for confirmation through a modal, which would stall a headless run.
            app.vault.setConfig('alwaysUpdateLinks', true);
            // See the file header: the default shortest-path format would leave every rewritten link textually identical.
            app.vault.setConfig('newLinkFormat', 'absolute');

            return snapshot;
          }
        });
      }

      /**
       * Waits, from Node, for every embed in the created note to reach the metadata cache.
       *
       * The handler builds its rewrite plan from that cache, so a half-resolved note would under-report the
       * defect.
       */
      async function waitForEmbedsToIndex(): Promise<void> {
        await pollInObsidian({
          input: { srcNote: SRC_NOTE },
          poll({ app, srcNote }): number {
            const note = app.vault.getFileByPath(srcNote);
            return note ? app.metadataCache.getFileCache(note)?.embeds?.length ?? 0 : 0;
          },
          timeoutInMilliseconds: INDEX_TIMEOUT_IN_MILLISECONDS,
          timeoutMessage: 'the note\'s embeds never reached the metadata cache',
          until: (embedCount: number): boolean => embedCount >= attachmentCount
        });
      }

      /**
       * Waits, from Node, for every embed in the moved note to resolve again.
       *
       * The timeout is swallowed deliberately: a link left stale must be reported by the assertion above,
       * which names WHICH links went stale — their identity is the evidence for the position-drift mechanism
       * — rather than as an opaque wait failure.
       */
      async function waitForLinksToSettle(): Promise<void> {
        try {
          await pollInObsidian({
            input: { destinationNote: DST_NOTE },
            async poll({ app, destinationNote }): Promise<number> {
              const movedNote = app.vault.getFileByPath(destinationNote);
              if (!movedNote) {
                return -1;
              }

              const content = await app.vault.read(movedNote);
              return [...content.matchAll(/!\[\[(?<linkPath>[^\]|]+)/g)]
                .map((match) => match.groups?.['linkPath']?.trim() ?? '')
                .filter((linkPath) => linkPath !== '' && !app.metadataCache.getFirstLinkpathDest(linkPath, destinationNote))
                .length;
            },
            timeoutInMilliseconds: REWRITE_TIMEOUT_IN_MILLISECONDS,
            timeoutMessage: 'some embeds in the moved note never resolved again',
            until: (staleLinkCount: number): boolean => staleLinkCount === 0
          });
        } catch {
          // Reported by the stale-link assertion instead.
        }
      }
    }, SCENARIO_TIMEOUT_IN_MILLISECONDS);
  }
});
