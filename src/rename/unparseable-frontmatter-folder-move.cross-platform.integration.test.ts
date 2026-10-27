import { evalInObsidian } from 'obsidian-integration-testing';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { PluginSettingsSnapshot } from '../settings/settings-snapshot.integration-helper.ts';

import {
  readPluginSettings,
  writePluginSettings
} from '../settings/settings-snapshot.integration-helper.ts';

/*
 * Moving a folder still rewrites its links when one of its notes has frontmatter that is not valid YAML.
 *
 * See https://github.com/RainCat1998/obsidian-custom-attachment-location/issues/142, filed against the plugin that
 * owned this handler before: moving a folder in the file explorer raised `An unhandled error occurred executing
 * async operation`, caused by a `YAMLParseError` on a property value like `[x]Some Author`, where the flow
 * sequence `[x]` is followed by more text. Obsidian indexes such a note's BODY links all the same, so the note is
 * a backlink holder like any other, and the handler reads holders while it verifies the backlinks it is about to
 * rewrite.
 *
 * The broken note links its sibling by full path, so the link must change when the folder moves, and the suite
 * asserts that it does and that nothing reached `console.error` along the way.
 *
 * Cross-platform: the manifest declares `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface MigratableSettingsLike {
  readonly shouldHandleRenames?: boolean;
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

interface UnparseableFrontmatterFolderMoveResult {
  readonly consoleErrors: readonly string[];
  readonly contentAfter: string;
  readonly contentBefore: string;
  readonly resolvedLinkPath: null | string;
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

describe('Moving a folder holding a note with unparseable frontmatter', () => {
  it('rewrites that note\'s links without an unhandled error', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<UnparseableFrontmatterFolderMoveResult> {
        const ROOT = 'rdh-unparseable-frontmatter';
        const OLD_FOLDER = `${ROOT}/Books`;
        const NEW_PARENT = `${ROOT}/Shelf`;
        const NEW_FOLDER = `${NEW_PARENT}/Books`;
        const TARGET_NAME = 'Target.md';
        const BROKEN_NAME = 'Broken.md';
        const PATH_LINK = `[[${OLD_FOLDER}/Target|Target]]`;
        /*
         * Under the transport's ~30s per-closure cap, not at it. Four charges — the settings helper's one wait, the
         * indexing wait, the rewrite wait and the re-index wait — at 6000 ms sum to 24 000 ms. Each waits on a
         * two-note folder, which lands in well under a second, so there is no long step to move to
         * `pollInObsidian`.
         */
        const WAIT_TIMEOUT_IN_MILLISECONDS = 6000;

        const apiRecord = (window as PluginApiRegistryHostLike).__obsidianLib?.pluginApiRegistry?.value?.records?.[pluginId]
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

        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');
        const originalConsoleError = console.error;
        const consoleErrors: string[] = [];
        // Synchronous, so the restore cannot interleave with an await the way an assignment in the `finally` could.
        function restoreConsoleError(): void {
          console.error = originalConsoleError;
        }

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          // Obsidian otherwise asks for confirmation through a modal, which would stall a headless run.
          app.vault.setConfig('alwaysUpdateLinks', true);

          await applySettings({ shouldHandleRenames: true });

          await app.vault.createFolder(OLD_FOLDER);
          await app.vault.createFolder(NEW_PARENT);
          const target = await app.vault.create(`${OLD_FOLDER}/${TARGET_NAME}`, '# Target\n');
          // The shape of the report's property: a flow sequence followed by more text on the same line.
          const broken = await app.vault.create(
            `${OLD_FOLDER}/${BROKEN_NAME}`,
            `---\ntitle: A history of oil\nauthor: [x]Some Author\naliases:\n---\n\n${PATH_LINK}\n`
          );

          await waitUntil({
            message: 'the broken note\'s body link to the target is indexed',
            predicate: () => app.metadataCache.getBacklinksForFile(target).keys().includes(broken.path),
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const contentBefore = await app.vault.read(broken);

          console.error = (...consoleArguments: unknown[]): void => {
            consoleErrors.push(consoleArguments.map((argument) => argument instanceof Error ? `${argument.name}: ${argument.message}` : String(argument)).join(' '));
            originalConsoleError.apply(console, consoleArguments);
          };

          const folder = app.vault.getFolderByPath(OLD_FOLDER);
          if (!folder) {
            throw new Error(`${OLD_FOLDER} is not indexed`);
          }

          await app.fileManager.renameFile(folder, NEW_FOLDER);

          const brokenAfterPath = `${NEW_FOLDER}/${BROKEN_NAME}`;
          await waitUntil({
            message: 'the full-path link in the broken note is rewritten',
            predicate: async () => {
              const content = await app.vault.adapter.read(brokenAfterPath);
              return !content.includes(PATH_LINK);
            },
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          }).catch(() => {
            // Reported by the assertions below, with the content and the errors attached.
          });
          await flushQueue();

          const contentAfter = await app.vault.adapter.read(brokenAfterPath);
          await waitUntil({
            message: 'the metadata cache has re-read the rewritten note',
            predicate: () => app.metadataCache.getFileCache(app.vault.getFileByPath(brokenAfterPath) ?? broken)?.links?.every((link) => contentAfter.includes(link.original)) ?? false,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const link = app.metadataCache.getFileCache(app.vault.getFileByPath(brokenAfterPath) ?? broken)?.links?.[0];

          return {
            consoleErrors,
            contentAfter,
            contentBefore,
            resolvedLinkPath: link ? app.metadataCache.getFirstLinkpathDest(link.link, brokenAfterPath)?.path ?? null : null
          };
        } finally {
          restoreConsoleError();
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
          /*
           * Through the adapter, as the other suites do: a fixture teardown must not travel back through the
           * very delete path this plugin patches, which would make the cleanup part of what is under test.
           */
          if (await app.vault.adapter.exists(ROOT)) {
            await app.vault.adapter.rmdir(ROOT, true);
          }
        }
      },
      input: {
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    expect(result.contentAfter).not.toBe(result.contentBefore);
    expect(result.resolvedLinkPath).toBe('rdh-unparseable-frontmatter/Shelf/Books/Target.md');
    /*
     * The one error allowed through is the library's own report naming the note (`Frontmatter parsing failed in
     * <path>`), printed when it edits the body of a note whose frontmatter it cannot read and then carries on. That
     * is the "skip and report" the reporter is owed; an `unhandled error` is the failure the issue describes.
     */
    expect(result.consoleErrors.filter((error) => !error.startsWith('Error: Frontmatter parsing failed in '))).toEqual([]);
  });
});
