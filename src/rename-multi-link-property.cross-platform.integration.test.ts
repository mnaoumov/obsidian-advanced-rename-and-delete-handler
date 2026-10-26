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
 * Renaming a note linked from inside a multi-link frontmatter value rewrites that link's span and leaves the rest
 * of the value as written: `"[[rename-multi-a]] and [Multi B](<rename-multi-b.md>)"` becomes
 * `"[[renamed multi a]] and [Multi B](<renamed multi b.md>)"` after both targets are renamed.
 *
 * Obsidian itself does not cache a link inside such a value; `Frontmatter Markdown Links` does, by adding one
 * `frontmatterLinks` entry per link, each carrying the WHOLE value as `original` and its own span as
 * `startOffset` / `endOffset`. This suite adds those entries itself, the same way and from the same library parser
 * (`parseFrontmatterLinks`), so it needs no foreign plugin installed. Like that plugin, it adds them again each time
 * Obsidian re-parses the note.
 *
 * With `shouldHandleRenames` on, the handler used to leave both links stale. Cross-platform: nothing about it is
 * desktop-specific.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-frontmatter-markdown-links';

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

interface MultiLinkPropertyRenameResult {
  /**
   * What the first rewrite was generated against: the vault's link format, and every file the new shortest name
   * resolves to. A full-path rewrite is what either an `absolute` format or a second match produces.
   */
  readonly linkContextAfterFirstRename: string;
  readonly valueAfterFirstRename: unknown;
  readonly valueAfterSecondRename: unknown;
  readonly valueBefore: unknown;
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

let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('Renaming notes linked from inside a multi-link frontmatter value', () => {
  it('rewrites each renamed link in place and keeps the rest of the value', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          flushQueue,
          parseFrontmatter,
          parseFrontmatterLinks,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<MultiLinkPropertyRenameResult> {
        const FOLDER = 'rdh-multi-link-property';
        const TARGET_A = `${FOLDER}/rename-multi-a.md`;
        const TARGET_B = `${FOLDER}/rename-multi-b.md`;
        const NEW_TARGET_A = `${FOLDER}/renamed multi a.md`;
        const NEW_TARGET_B = `${FOLDER}/renamed multi b.md`;
        const SOURCE_NOTE = `${FOLDER}/source.md`;
        const KEY = 'multipleLinks';
        /*
         * Under the transport's ~30s per-closure cap, not at it. Five charges: `applySettings` once, and four
         * waits of the closure's own. Each lands in well under a second.
         */
        const WAIT_TIMEOUT_IN_MILLISECONDS = 5000;

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
          // Never rejects, so awaiting it keeps it from floating; the migration's own rejection surfaces below.
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
         * Adds the multi-value links of the source note to Obsidian's live cache entry for it, as `Frontmatter
         * Markdown Links` does: its own entries for the key replace Obsidian's, and the note's resolved links are
         * recounted. Does nothing until Obsidian has parsed the note's frontmatter.
         */
        function contributeMultiValueLinks(): void {
          const hash = app.metadataCache.fileCache[SOURCE_NOTE]?.hash;
          const cache = hash ? app.metadataCache.metadataCache[hash] : undefined;
          if (!cache) {
            return;
          }

          const { multiValueFrontmatterLinks } = parseFrontmatterLinks(cache.frontmatter);
          if (multiValueFrontmatterLinks.length === 0) {
            return;
          }

          const contributedKeys = new Set(multiValueFrontmatterLinks.map((reference) => reference.key));
          cache.frontmatterLinks = (cache.frontmatterLinks ?? []).filter((link) => !contributedKeys.has(link.key));
          for (const reference of multiValueFrontmatterLinks) {
            cache.frontmatterLinks.push(
              {
                displayText: reference.displayText,
                endOffset: reference.endOffset,
                key: reference.key,
                link: reference.link,
                original: reference.original,
                startOffset: reference.startOffset
              } as (typeof cache.frontmatterLinks)[number]
            );
          }

          app.metadataCache.resolveLinks(SOURCE_NOTE);
        }

        /**
         * Reads the value of the multi-link key from the source note's file on disk.
         *
         * @returns The value, as parsed from the frontmatter.
         */
        async function readValue(): Promise<unknown> {
          const frontmatter = parseFrontmatter(await app.vault.adapter.read(SOURCE_NOTE));
          return frontmatter[KEY];
        }

        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');
        const originalNewLinkFormat = app.vault.getConfig('newLinkFormat');
        const changedEventRef = app.metadataCache.on('changed', (file) => {
          if (file.path === SOURCE_NOTE) {
            contributeMultiValueLinks();
          }
        });

        try {
          app.vault.setConfig('alwaysUpdateLinks', true);
          /*
           * The expected values are shortest-form links, so the format is stated here rather than inherited from
           * the suites before this one, three of which switch it to `absolute`. Saved at once: until the save
           * lands, a reload of `app.json` can bring back whatever an earlier suite left on disk.
           */
          app.vault.setConfig('newLinkFormat', 'shortest');
          await app.vault.saveConfig();
          await applySettings({ shouldHandleRenames: true });

          await app.vault.createFolder(FOLDER);
          const targetA = await app.vault.create(TARGET_A, '# A\n');
          const targetB = await app.vault.create(TARGET_B, '# B\n');
          await app.vault.create(SOURCE_NOTE, `---\n${KEY}: "[[rename-multi-a]] and [Multi B](<rename-multi-b.md>)"\n---\n`);

          await waitUntil({
            message: 'both multi-value links of the source note are cached as backlinks',
            predicate: () => {
              contributeMultiValueLinks();
              return app.metadataCache.getBacklinksForFile(targetA).keys().includes(SOURCE_NOTE)
                && app.metadataCache.getBacklinksForFile(targetB).keys().includes(SOURCE_NOTE);
            },
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const valueBefore = await readValue();

          await app.fileManager.renameFile(targetA, NEW_TARGET_A);
          // The effect first, then the drain: the handler enqueues its work from the rename event.
          await waitUntil({
            message: 'the link to A is rewritten',
            predicate: async () => (await readValue()) !== valueBefore,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });
          await flushQueue();
          const valueAfterFirstRename = await readValue();
          const shortestNameMatches = app.metadataCache.getLinkpathDest('renamed multi a', SOURCE_NOTE).map((file) => file.path);
          const linkContextAfterFirstRename = `newLinkFormat: ${String(app.vault.getConfig('newLinkFormat'))}; `
            + `'renamed multi a' resolves to: ${shortestNameMatches.join(', ') || '(nothing)'}`;

          await waitUntil({
            message: 'the rewritten source note is cached with its multi-value links again',
            predicate: () => {
              contributeMultiValueLinks();
              return app.metadataCache.getBacklinksForFile(targetB).keys().includes(SOURCE_NOTE);
            },
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          await app.fileManager.renameFile(targetB, NEW_TARGET_B);
          await waitUntil({
            message: 'the link to B is rewritten',
            predicate: async () => (await readValue()) !== valueAfterFirstRename,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });
          await flushQueue();
          const valueAfterSecondRename = await readValue();

          return {
            linkContextAfterFirstRename,
            valueAfterFirstRename,
            valueAfterSecondRename,
            valueBefore
          };
        } finally {
          app.metadataCache.offref(changedEventRef);
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
          app.vault.setConfig('newLinkFormat', originalNewLinkFormat);
          await app.vault.saveConfig();
          // Through the adapter, so the teardown does not travel back through the delete path this plugin patches.
          if (await app.vault.adapter.exists(FOLDER)) {
            await app.vault.adapter.rmdir(FOLDER, true);
          }
        }
      },
      input: {
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    expect(result.valueBefore).toBe('[[rename-multi-a]] and [Multi B](<rename-multi-b.md>)');
    expect(result.valueAfterFirstRename, result.linkContextAfterFirstRename).toBe('[[renamed multi a]] and [Multi B](<rename-multi-b.md>)');
    expect(result.valueAfterSecondRename).toBe('[[renamed multi a]] and [Multi B](<renamed multi b.md>)');
  });
});
