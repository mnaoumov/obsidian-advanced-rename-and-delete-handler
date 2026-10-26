import type { EventRef } from 'obsidian';

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
 * Moving every note that embeds a shared attachment, one after another, used to leave the attachment behind
 * in the source folder. See https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/issues/5.
 *
 * A batch move from the file explorer is a run of single renames, and each one is handled on its own. The
 * handler moved a linked attachment only when no OTHER note linked it, so the first note left the shared file
 * for the second, still in `Source`, and the second left it for the first, now in `Destination` and still
 * linking it. Nothing ever moved it, and the moved notes all pointed back into a folder that looked empty.
 *
 * The staging is the reporter's own: `attachmentFolderPath: ./_attachments` and standard Markdown embeds
 * `![](_attachments/Shared.png)`. `alwaysUpdateLinks` is on so a link update never waits on Obsidian's own
 * confirmation, which nobody answers headless.
 *
 * The second case pins the other half: while one note that embeds it stays behind, the attachment stays too.
 *
 * Cross-platform: the manifest declares `isDesktopOnly: false`, and a batch move happens on a phone as well.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface BatchMoveInput {
  readonly movedNoteNames: readonly string[];
  readonly noteNames: readonly string[];
  readonly pluginId: string;
  readonly root: string;
  readonly sourcePluginId: string;
}

interface BatchMoveResult {
  readonly doesDestinationAttachmentExist: boolean;
  readonly doesSourceAttachmentExist: boolean;
  /**
   * What the handler saw at each rename, the files left under the fixture root, and each note's text: what a
   * missing attachment needs to be told apart from a moved-elsewhere one.
   */
  readonly report: string;
  readonly resolvedPaths: Record<string, null | string>;
}

interface MigratableSettingsLike {
  readonly shouldHandleRenames?: boolean;
  readonly shouldRenameAttachmentFiles?: boolean;
  readonly shouldRenameAttachmentFolder?: boolean;
  readonly shouldRescueSharedAttachments?: boolean;
}

interface MigrateSettingsParamsLike {
  readonly proposedSettings: MigratableSettingsLike;
  readonly sourcePluginId: string;
}

interface MigrateSettingsResultLike {
  readonly isApplied: boolean;
}

interface MigrationApiLike {
  getSettings: () => Readonly<Record<string, unknown>>;
  migrateSettings: (params: MigrateSettingsParamsLike) => Promise<MigrateSettingsResultLike>;
}

interface ObsidianLibStateLike {
  readonly pluginApiRegistry?: PluginApiRegistryWrapperLike;
}

/**
 * The slice of the `@mnaoumov/obsidian-lib` cross-plugin registry a closure reads the API from: the wire-level path
 * that library's Plugin API protocol guide freezes, so a suite reaches the plugin the way a consumer does.
 */
interface PluginApiRegistryHostLike {
  readonly __obsidianLib?: ObsidianLibStateLike;
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

async function runBatchMove(input: BatchMoveInput): Promise<BatchMoveResult> {
  return await evalInObsidian({
    async callback({
      app,
      lib: {
        flushQueue,
        waitUntil
      },
      movedNoteNames,
      noteNames,
      pluginId,
      root,
      sourcePluginId
    }): Promise<BatchMoveResult> {
      const SOURCE = `${root}/Source`;
      const DESTINATION = `${root}/Destination`;
      const SOURCE_ATTACHMENT = `${SOURCE}/_attachments/Shared.png`;
      const DESTINATION_ATTACHMENT = `${DESTINATION}/_attachments/Shared.png`;
      /*
       * Under the transport's ~30s per-closure cap, not at it. Five charges: the settings dialog, the index
       * wait, one settle per moved note (two at most), and the final effect wait. Each lands in well under a
       * second on a vault this size, so 4000 ms apiece costs nothing and sums to 20 000.
       */
      const WAIT_TIMEOUT_IN_MILLISECONDS = 4000;

      const apiRecord = (window as PluginApiRegistryHostLike).__obsidianLib?.pluginApiRegistry?.value?.records?.[pluginId]
        ?.find((candidate) => !candidate.isRevoked);
      if (!apiRecord) {
        throw new Error(`${pluginId} has published no API`);
      }

      const api = apiRecord.api;

      /**
       * Writes settings through the plugin's own migration API and approves the dialog it raises.
       *
       * @param proposedSettings - The settings to write.
       */
      async function applySettings(proposedSettings: MigratableSettingsLike): Promise<void> {
        const migrationPromise = api.migrateSettings({
          proposedSettings,
          sourcePluginId
        });
        let isSettled = false;
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
       * Lists what the handler saw at each rename, the files left under the fixture root, and each note's text.
       *
       * @param configsAtRenames - The lines the `rename` listener recorded.
       * @returns The report, one line per entry.
       */
      async function buildReport(configsAtRenames: readonly string[]): Promise<string> {
        const filePaths = app.vault.getFiles().map((file) => file.path).filter((path) => path.startsWith(`${root}/`)).sort();
        const lines = [...configsAtRenames, `files: ${JSON.stringify(filePaths)}`];
        for (const file of app.vault.getMarkdownFiles()) {
          if (file.path.startsWith(`${root}/`)) {
            lines.push(`${file.path}: ${JSON.stringify(await app.vault.cachedRead(file))}`);
          }
        }

        return lines.join('\n');
      }

      const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');
      const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');
      let renameEventRef: EventRef | null = null;

      try {
        app.vault.setConfig('alwaysUpdateLinks', true);
        app.vault.setConfig('attachmentFolderPath', './_attachments');
        /*
         * Saved at once: a config reload in the case's few hundred milliseconds would otherwise put back what
         * `app.json` holds, and the handler would look for an attachment folder that does not exist and move
         * nothing.
         */
        await app.vault.saveConfig();

        // The values the handler reads, at the moment of each rename it handles; the failure report quotes them.
        const configsAtRenames: string[] = [];
        renameEventRef = app.vault.on('rename', (file, oldPath) => {
          const attachmentFolderPath = JSON.stringify(app.vault.getConfig('attachmentFolderPath')) ?? 'undefined';
          configsAtRenames.push(`${oldPath} -> ${file.path}: attachmentFolderPath ${attachmentFolderPath}, settings ${JSON.stringify(api.getSettings())}`);
        });

        await applySettings({
          shouldHandleRenames: true,
          shouldRenameAttachmentFiles: false,
          shouldRenameAttachmentFolder: true,
          shouldRescueSharedAttachments: false
        });

        await app.vault.createFolder(`${SOURCE}/_attachments`);
        await app.vault.createFolder(DESTINATION);
        const attachment = await app.vault.createBinary(SOURCE_ATTACHMENT, new ArrayBuffer(8));
        for (const noteName of noteNames) {
          await app.vault.create(`${SOURCE}/${noteName}`, '![](_attachments/Shared.png)\n');
        }

        await waitUntil({
          message: 'every note\'s embed of the shared attachment is indexed',
          predicate: () => app.metadataCache.getBacklinksForFile(attachment).keys().length === noteNames.length,
          timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
        });

        // One rename after another, as the file explorer's batch move does it.
        for (const noteName of movedNoteNames) {
          const note = app.vault.getFileByPath(`${SOURCE}/${noteName}`);
          if (!note) {
            throw new Error(`${noteName} was not created`);
          }

          await Promise.race([
            app.fileManager.renameFile(note, `${DESTINATION}/${noteName}`).catch(() => {
              // A lingering `onCleanCache`; the effect is read below.
            }),
            sleep(WAIT_TIMEOUT_IN_MILLISECONDS)
          ]);
        }

        // The effect first, then the drain: `flushQueue` covers only what is already enqueued.
        await waitUntil({
          message: 'every moved note is at its destination',
          predicate: () => movedNoteNames.every((noteName) => app.vault.getFileByPath(`${DESTINATION}/${noteName}`) !== null),
          timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
        });
        await flushQueue();

        const resolvedPaths: Record<string, null | string> = {};
        for (const noteName of noteNames) {
          const notePath = movedNoteNames.includes(noteName) ? `${DESTINATION}/${noteName}` : `${SOURCE}/${noteName}`;
          const note = app.vault.getFileByPath(notePath);
          const embed = note ? app.metadataCache.getFileCache(note)?.embeds?.[0] : undefined;
          resolvedPaths[noteName] = embed ? app.metadataCache.getFirstLinkpathDest(embed.link, notePath)?.path ?? null : null;
        }

        return {
          doesDestinationAttachmentExist: app.vault.getFileByPath(DESTINATION_ATTACHMENT) !== null,
          doesSourceAttachmentExist: app.vault.getFileByPath(SOURCE_ATTACHMENT) !== null,
          report: await buildReport(configsAtRenames),
          resolvedPaths
        };
      } finally {
        if (renameEventRef) {
          app.vault.offref(renameEventRef);
        }
        app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
        app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
        // Saved at once, so a reload of `app.json` before the debounced save cannot hand the next suite this case's folder.
        await app.vault.saveConfig();
        /*
         * Through the adapter: a fixture teardown must not travel back through the very delete path this
         * plugin patches, which would make the cleanup part of what is under test.
         */
        if (await app.vault.adapter.exists(root)) {
          await app.vault.adapter.rmdir(root, true);
        }
      }
    },
    // Spelled out field by field: an interface is not assignable to the transport's `Record<string, unknown>`.
    input: {
      movedNoteNames: [...input.movedNoteNames],
      noteNames: [...input.noteNames],
      pluginId: input.pluginId,
      root: input.root,
      sourcePluginId: input.sourcePluginId
    }
  });
}

describe('Moving every note that embeds a shared attachment', () => {
  it('takes the attachment along once the last of them has moved', async () => {
    const result = await runBatchMove({
      movedNoteNames: ['Note 1.md', 'Note 2.md'],
      noteNames: ['Note 1.md', 'Note 2.md'],
      pluginId: PLUGIN_ID,
      root: 'rdh-shared-batch-move-all',
      sourcePluginId: SOURCE_PLUGIN_ID
    });

    expect(result.doesDestinationAttachmentExist, result.report).toBe(true);
    expect(result.doesSourceAttachmentExist).toBe(false);
    expect(result.resolvedPaths).toEqual({
      'Note 1.md': 'rdh-shared-batch-move-all/Destination/_attachments/Shared.png',
      'Note 2.md': 'rdh-shared-batch-move-all/Destination/_attachments/Shared.png'
    });
  });

  it('leaves the attachment where it is while a note that embeds it stays behind', async () => {
    const result = await runBatchMove({
      movedNoteNames: ['Note 1.md', 'Note 2.md'],
      noteNames: ['Note 1.md', 'Note 2.md', 'Note 3.md'],
      pluginId: PLUGIN_ID,
      root: 'rdh-shared-batch-move-some',
      sourcePluginId: SOURCE_PLUGIN_ID
    });

    expect(result.doesDestinationAttachmentExist, result.report).toBe(false);
    expect(result.doesSourceAttachmentExist).toBe(true);
    expect(result.resolvedPaths).toEqual({
      'Note 1.md': 'rdh-shared-batch-move-some/Source/_attachments/Shared.png',
      'Note 2.md': 'rdh-shared-batch-move-some/Source/_attachments/Shared.png',
      'Note 3.md': 'rdh-shared-batch-move-some/Source/_attachments/Shared.png'
    });
  });
});
