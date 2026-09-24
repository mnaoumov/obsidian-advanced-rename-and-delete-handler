import type { EventRef } from 'obsidian';

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
 *
 * ## The waiting happens in NODE, and no ceiling could have replaced that
 *
 * The whole argument is in the sibling suite's header and is not repeated: this scenario had the same shape
 * and the same 240 000 ms declared inside one transport call, and the same reason no smaller ceiling would
 * do. What this suite adds is a second piece of state that cannot cross the boundary — the emulated plugin's
 * `EventRef` and the flag its listener sets — so here the `contextId` carries three things rather than one:
 * the listener's registration (so the Node-side `finally` can take it off again), the flag, and the fired
 * rename's rejection. The listener is registered in `start`, immediately before the rename it has to fire
 * inside, because that ordering is the whole scenario.
 *
 * `flushQueue()` still runs, in the `finally` rather than on the line after the rename — see the sibling
 * header for why dropping it was measurably wrong, and for where this repo's own rule says it belongs.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';
const ATTACHMENT_COUNT = 30;
const SCENARIO_TIMEOUT_IN_MILLISECONDS = 180_000;
const INSERTED_LINE = 'A line inserted mid-rename to shift the offsets after it.';

const SRC_FOLDER = 'rdh-note-move-edit-src';
// Deliberately longer than the source, so every rewritten link grows and the links after it shift.
const DST_FOLDER = 'rdh-note-move-edit-destination-with-a-much-longer-name';
const SRC_NOTE = `${SRC_FOLDER}/note.md`;
const DST_NOTE = `${DST_FOLDER}/note.md`;
const SRC_ATTACHMENT_FOLDER = `${SRC_FOLDER}/assets`;
const DST_ATTACHMENT_FOLDER = `${DST_FOLDER}/assets`;

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
 * the plugin's own operation queue, with an outside edit landing in the middle of it. Safe to be long because
 * Node does the waiting.
 */
const MOVE_TIMEOUT_IN_MILLISECONDS = 90_000;

/**
 * The Node-side budget for the rewritten links to settle.
 */
const REWRITE_TIMEOUT_IN_MILLISECONDS = 45_000;

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
  migrateSettings: (params: MigrateSettingsParamsLike) => Promise<MigrateSettingsResultLike>;
}

/**
 * What the move poll reports back to Node.
 */
interface MoveProbe {
  readonly isEditApplied: boolean;
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
 * The state `start` leaves behind, shared through the call's {@link ContextId}.
 *
 * None of the three can be serialized across the transport, which is what this parameter exists for: an
 * `EventRef` is an opaque Obsidian handle, and the other two are written by callbacks that outlive the call
 * that registered them.
 */
interface NoteMoveContext {
  eventRef?: EventRef;
  isEditApplied?: boolean;
  renameError?: string;
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

describe('A note edited by another plugin while it is being moved', () => {
  it('still has every one of its embeds resolving', async () => {
    const contextId = new ContextId<NoteMoveContext>();
    const originalConfigs = await stageVaultConfigs();

    try {
      await applySettings();
      await createFixture();
      await waitForEmbedsToIndex();
      const moveProbe = await moveNote();
      await waitForLinksToSettle();

      const result = await readResult(moveProbe.isEditApplied);

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
     * sibling suite's header for what dropping it cost — and it runs from the `finally` so a failed assertion
     * cannot hand a live queue to the next suite.
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
          count: ATTACHMENT_COUNT,
          destinationFolder: DST_FOLDER,
          srcAttachmentFolder: SRC_ATTACHMENT_FOLDER,
          srcNote: SRC_NOTE
        }
      });
    }

    /**
     * Registers the emulated second plugin, fires the rename, and waits from Node for every attachment to
     * arrive in the destination folder.
     *
     * `start` does NOT await the rename: awaiting it would put the whole move — the very thing that can run
     * for minutes — back inside one transport call. The attachment count arriving is the proof the queue ran,
     * in place of the `flushQueue()` the old shape awaited here.
     *
     * @returns The last probe, which carries whether the emulated plugin's edit landed.
     */
    async function moveNote(): Promise<MoveProbe> {
      const probe = await pollInObsidian({
        contextId,
        input: {
          destinationAttachmentFolder: DST_ATTACHMENT_FOLDER,
          destinationNote: DST_NOTE,
          insertedLine: INSERTED_LINE,
          srcNote: SRC_NOTE
        },
        poll({ app, context, destinationAttachmentFolder }): MoveProbe {
          return {
            isEditApplied: context.isEditApplied ?? false,
            movedAttachmentCount: app.vault.getFiles().filter((file) => file.path.startsWith(`${destinationAttachmentFolder}/`)).length,
            renameError: context.renameError ?? null
          };
        },
        start({
          app,
          context,
          destinationAttachmentFolder,
          destinationNote,
          insertedLine,
          srcNote
        }): void {
          const note = app.vault.getFileByPath(srcNote);
          if (!note) {
            throw new Error(`Note ${srcNote} not found.`);
          }

          /*
           * The emulated second plugin. It fires on the FIRST attachment rename — which happens after the
           * handler has snapshotted its link keys and before it rewrites them — and inserts a line halfway
           * down the note, shifting every link below it. A real co-installed link-rewriting plugin perturbs
           * the same window; this is the minimal deterministic stand-in for one.
           */
          context.eventRef = app.vault.on('rename', (file) => {
            if ((context.isEditApplied ?? false) || !file.path.startsWith(`${destinationAttachmentFolder}/`)) {
              return;
            }

            context.isEditApplied = true;
            const noteFile = app.vault.getFileByPath(destinationNote) ?? app.vault.getFileByPath(srcNote);
            if (!noteFile) {
              return;
            }

            app.vault.process(noteFile, (content) => {
              const blocks = content.split('\n\n');
              const insertAt = Math.floor(blocks.length / 2);
              return [...blocks.slice(0, insertAt), insertedLine, ...blocks.slice(insertAt)].join('\n\n');
            }).catch(() => {
              /*
               * The vault `rename` callback is synchronous, so this edit is fire-and-forget. A failure is not
               * swallowed silently: `isEditApplied` is asserted below, and the suite is meaningless without it.
               */
            });
          });

          app.fileManager.renameFile(note, destinationNote).catch((error: unknown) => {
            context.renameError = error instanceof Error ? error.message : String(error);
          });
        },
        timeoutInMilliseconds: MOVE_TIMEOUT_IN_MILLISECONDS,
        timeoutMessage: 'the attachments never finished moving into the destination folder',
        until: (result: MoveProbe): boolean => result.renameError !== null || result.movedAttachmentCount >= ATTACHMENT_COUNT
      });

      if (probe.renameError !== null) {
        throw new Error(`the rename rejected: ${probe.renameError}`);
      }

      return probe;
    }

    /**
     * Reads what the move left behind.
     *
     * @param wasEditApplied - What the move poll saw of the emulated plugin's edit.
     * @returns The moved note's content, its embeds, and which of them resolve to nothing.
     */
    async function readResult(wasEditApplied: boolean): Promise<ConcurrentEditResult> {
      return await evalInObsidian({
        async callback({
          app,
          destinationAttachmentFolder,
          destinationNote,
          isEditApplied
        }): Promise<ConcurrentEditResult> {
          const movedNote = app.vault.getFileByPath(destinationNote);
          if (!movedNote) {
            throw new Error(`Note ${destinationNote} not found.`);
          }

          const noteContentAfter = await app.vault.read(movedNote);
          return {
            isEditApplied,
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
          destinationNote: DST_NOTE,
          isEditApplied: wasEditApplied
        }
      });
    }

    /**
     * Takes the emulated plugin's listener off, puts the vault configs back, and removes the two folders this
     * scenario created.
     *
     * Runs from a Node-side `finally`, so it happens however the scenario ends — a timed-out poll included.
     * The listener is taken off through the same `context` that registered it, which is why this closure
     * carries the `contextId` too.
     *
     * @param configs - What {@link stageVaultConfigs} read before overwriting them.
     */
    async function restore(configs: VaultConfigSnapshot): Promise<void> {
      await evalInObsidian({
        async callback({
          alwaysUpdateLinks,
          app,
          attachmentFolderPath,
          context,
          folderPaths,
          newLinkFormat
        }): Promise<void> {
          if (context.eventRef) {
            app.vault.offref(context.eventRef);
          }

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
        contextId,
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
        until: (embedCount: number): boolean => embedCount >= ATTACHMENT_COUNT
      });
    }

    /**
     * Waits, from Node, for every embed in the moved note to resolve again.
     *
     * The timeout is swallowed deliberately: a link left stale must be reported by the assertion above, which
     * names WHICH links went stale — the broken build fails with exactly the contiguous tail after the
     * insertion point, and that identity is the evidence for the mechanism — rather than as an opaque wait
     * failure.
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
});
