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
 * Moving a note rewrites a frontmatter property that links to it exactly as it rewrites the same link in the
 * body. Frontmatter links are a separate list in the metadata cache (`frontmatterLinks`, keyed by property
 * rather than positioned in the text), so a handler that walked only `links` / `embeds` would leave them
 * behind with nothing else noticing.
 *
 * See https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/issues/2, whose steps this
 * stages under a neutral name: a note under `Clippings/` whose `author` property links to a root-level note,
 * which is then moved into a folder whose name carries a comma, a space and an ampersand.
 *
 * Every link is staged twice, once in the frontmatter and once in the body, and the assertion is that the two
 * copies come out identical, whatever the vault's `newLinkFormat`. That is the form-independent statement of
 * the promise. Under the default `shortest` format the report's own bare-name link legitimately comes back
 * UNCHANGED, because a bare base name still resolves once the note has moved; the aliased full-path link
 * beside it is the one that must change in every format, which is what the suite waits on to know the
 * handler has run. Making the handler skip frontmatter links fails all three cases on that second link, left
 * naming the folder the note moved out of.
 *
 * Cross-platform: the report came from iOS, and the manifest declares `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

interface FrontmatterLinkRenameResult {
  readonly bodyLinks: readonly string[];
  readonly contentAfter: string;
  readonly contentBefore: string;
  readonly frontmatterLinks: readonly string[];
  readonly resolvedFrontmatterLinkPaths: readonly (null | string)[];
}

interface MigratableSettingsLike {
  readonly shouldHandleRenames?: boolean;
  readonly shouldUpdateFileNameAliases?: boolean;
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

describe('Moving a note linked from a frontmatter property', () => {
  it.each(['shortest', 'relative', 'absolute'])('rewrites the property as it rewrites the body link (%s)', async (newLinkFormat) => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          waitUntil
        },
        newLinkFormat: linkFormat,
        pluginId,
        sourcePluginId
      }): Promise<FrontmatterLinkRenameResult> {
        const ROOT = `rdh-frontmatter-link-${linkFormat}`;
        const OLD_TARGET = `${ROOT}/Jane Doe.md`;
        const NEW_FOLDER = `${ROOT}/Authors, Publications & Models`;
        const NEW_TARGET = `${NEW_FOLDER}/Jane Doe.md`;
        const SOURCE = `${ROOT}/Clippings/Some article.md`;
        const BARE_LINK = '[[Jane Doe]]';
        const PATH_LINK = `[[${ROOT}/Jane Doe|Jane Doe]]`;
        /*
         * Under the transport's ~30s per-closure cap, not at it. Four charges — the settings helper's one wait,
         * the indexing wait, the rewrite wait and the re-index wait — at 6000 ms sum to 24 000 ms. Each waits on
         * a three-note vault, which lands in well under a second, so there is no long step to move to
         * `pollInObsidian`.
         */
        const WAIT_TIMEOUT_IN_MILLISECONDS = 6000;

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

        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');
        const originalNewLinkFormat = app.vault.getConfig('newLinkFormat');

        // Everything that mutates shared state sits inside the `try`, so the `finally` below puts the vault back however this ends.
        try {
          // Obsidian otherwise asks for confirmation through a modal, which would stall a headless run.
          app.vault.setConfig('alwaysUpdateLinks', true);
          app.vault.setConfig('newLinkFormat', linkFormat);

          // The two settings the report names, stated so the scenario cannot drift with the defaults.
          await applySettings({
            shouldHandleRenames: true,
            shouldUpdateFileNameAliases: true
          });

          await app.vault.createFolder(`${ROOT}/Clippings`);
          await app.vault.createFolder(NEW_FOLDER);
          const target = await app.vault.create(OLD_TARGET, '# Jane Doe\n');
          const source = await app.vault.create(
            SOURCE,
            `---\nauthor: "${BARE_LINK}"\nauthorPath: "${PATH_LINK}"\n---\n\n${BARE_LINK}\n\n${PATH_LINK}\n`
          );

          await waitUntil({
            message: 'all four links to the target are indexed',
            predicate: () => {
              const cache = app.metadataCache.getFileCache(source);
              return cache?.frontmatterLinks?.length === 2 && cache.links?.length === 2
                && app.metadataCache.getBacklinksForFile(target).keys().length > 0;
            },
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const contentBefore = await app.vault.read(source);

          await app.fileManager.renameFile(target, NEW_TARGET);

          /*
           * The aliased full-path link names a folder the note has left, so it changes in every format; its
           * body copy changing is the observable effect proving the handler is underway. Only then does
           * `flushQueue` have the rest of that operation to wait for.
           */
          await waitUntil({
            message: 'the full-path body link is rewritten',
            predicate: async () => {
              const content = await app.vault.read(source);
              return !content.trimEnd().endsWith(PATH_LINK);
            },
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });
          await flushQueue();

          const contentAfter = await app.vault.read(source);
          await waitUntil({
            message: 'the metadata cache has re-read the rewritten note',
            predicate: () => app.metadataCache.getFileCache(source)?.frontmatterLinks?.every((link) => contentAfter.includes(link.original)) ?? false,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const cache = app.metadataCache.getFileCache(source);
          const frontmatterLinks = cache?.frontmatterLinks ?? [];

          return {
            bodyLinks: (cache?.links ?? []).map((link) => link.original),
            contentAfter,
            contentBefore,
            frontmatterLinks: frontmatterLinks.map((link) => link.original),
            resolvedFrontmatterLinkPaths: frontmatterLinks.map((link) => app.metadataCache.getFirstLinkpathDest(link.link, SOURCE)?.path ?? null)
          };
        } finally {
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
          app.vault.setConfig('newLinkFormat', originalNewLinkFormat);
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
        newLinkFormat,
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    const newTargetPath = `rdh-frontmatter-link-${newLinkFormat}/Authors, Publications & Models/Jane Doe.md`;

    expect(result.contentAfter).not.toBe(result.contentBefore);
    expect(result.resolvedFrontmatterLinkPaths).toEqual([newTargetPath, newTargetPath]);
    // Frontmatter first, body second: the same two links in the same order, so the lists must match exactly.
    expect(result.frontmatterLinks).toEqual(result.bodyLinks);
  });
});
