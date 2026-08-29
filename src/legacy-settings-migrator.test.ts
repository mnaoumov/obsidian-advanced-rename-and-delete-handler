import type {
  App as AppOriginal,
  DataAdapter
} from 'obsidian';

import { EmptyFolderBehavior } from 'obsidian-dev-utils/obsidian/components/rename-delete-handler-component';
import { strictProxy } from 'obsidian-dev-utils/strict-proxy';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { migrateLegacySettings } from './legacy-settings-migrator.ts';
import { PluginSettings } from './plugin-settings.ts';

type LegacyDataByPluginId = Record<string, string>;

const CONFIG_DIRECTORY = '.my-obsidian-config';
const OCAL_ID = 'obsidian-custom-attachment-location';
const OCAAL_ID = 'consistent-attachments-and-links';
const OBML_ID = 'better-markdown-links';
const OERH_ID = 'external-rename-handler';
const OFML_ID = 'frontmatter-markdown-links';

function createApp(legacyDataByPluginId: LegacyDataByPluginId): AppOriginal {
  const dataByPath: Record<string, string> = {};
  for (const [pluginId, data] of Object.entries(legacyDataByPluginId)) {
    dataByPath[`${CONFIG_DIRECTORY}/plugins/${pluginId}/data.json`] = data;
  }

  return strictProxy<AppOriginal>({
    vault: strictProxy<AppOriginal['vault']>({
      adapter: strictProxy<DataAdapter>({
        exists: vi.fn((path: string) => Promise.resolve(Object.hasOwn(dataByPath, path))),
        read: vi.fn((path: string) => Promise.resolve(dataByPath[path] ?? ''))
      }),
      // eslint-disable-next-line unicorn/name-replacements -- `configDir` is Obsidian's own `Vault` property name.
      configDir: CONFIG_DIRECTORY
    })
  });
}

function json(data: object): string {
  // `String` rather than a cast: the strict lib types `JSON.stringify` as a branded result.
  return String(JSON.stringify(data));
}

describe('migrateLegacySettings', () => {
  it('should import nothing from a vault that never had any of them', async () => {
    const settings = new PluginSettings();

    const result = await migrateLegacySettings(createApp({}), settings);

    expect(result.importedFromPluginIds).toEqual([]);
    expect(settings.shouldHandleDeletions).toBe(false);
  });

  it('should report which plugins contributed', async () => {
    const app = createApp({
      [OCAL_ID]: json({ shouldHandleRenames: true }),
      [OFML_ID]: json({ shouldHandleRenames: true })
    });

    const result = await migrateLegacySettings(app, new PluginSettings());

    expect(result.importedFromPluginIds).toEqual([OCAL_ID, OFML_ID]);
  });

  it('should map OCAL keys onto ours', async () => {
    const settings = new PluginSettings();
    const app = createApp({
      [OCAL_ID]: json({
        shouldDeleteOrphanAttachments: true,
        shouldRenameAttachmentFiles: true,
        shouldRescueSharedAttachments: true
      })
    });

    await migrateLegacySettings(app, settings);

    expect(settings.shouldHandleDeletions).toBe(true);
    expect(settings.shouldRenameAttachmentFiles).toBe(true);
    expect(settings.shouldRescueSharedAttachments).toBe(true);
  });

  it('should map OCAAL keys onto ours', async () => {
    const settings = new PluginSettings();
    const app = createApp({
      [OCAAL_ID]: json({
        shouldChangeNoteBacklinksDisplayText: true,
        shouldDeleteAttachmentsWithNote: true,
        shouldDeleteExistingFilesWhenMovingNote: true,
        shouldMoveAttachmentsWithNote: true
      })
    });

    await migrateLegacySettings(app, settings);

    expect(settings.shouldHandleDeletions).toBe(true);
    expect(settings.shouldDeleteConflictingAttachments).toBe(true);
    expect(settings.shouldRenameAttachmentFolder).toBe(true);
    expect(settings.shouldUpdateFileNameAliases).toBe(true);
  });

  it('should map each of the three smaller consumers onto shouldHandleRenames', async () => {
    for (
      const legacyData of [
        { [OBML_ID]: json({ shouldAutomaticallyUpdateLinksOnRenameOrMove: true }) },
        { [OERH_ID]: json({ shouldUpdateLinks: true }) },
        { [OFML_ID]: json({ shouldHandleRenames: true }) }
      ]
    ) {
      const settings = new PluginSettings();
      settings.shouldHandleRenames = false;

      await migrateLegacySettings(createApp(legacyData), settings);

      expect(settings.shouldHandleRenames).toBe(true);
    }
  });

  it('should OR booleans across consumers and never turn one off', async () => {
    const settings = new PluginSettings();
    const app = createApp({
      [OCAAL_ID]: json({ shouldDeleteAttachmentsWithNote: false }),
      [OCAL_ID]: json({ shouldDeleteOrphanAttachments: true })
    });

    await migrateLegacySettings(app, settings);

    expect(settings.shouldHandleDeletions).toBe(true);
  });

  it('should take the first empty-folder behavior offered and keep it', async () => {
    const settings = new PluginSettings();
    const app = createApp({
      [OCAAL_ID]: json({ emptyFolderBehavior: EmptyFolderBehavior.Delete }),
      [OCAL_ID]: json({ emptyFolderBehavior: EmptyFolderBehavior.DeleteWithEmptyParents })
    });

    await migrateLegacySettings(app, settings);

    expect(settings.emptyFolderBehavior).toBe(EmptyFolderBehavior.DeleteWithEmptyParents);
  });

  it('should ignore an unrecognized empty-folder behavior', async () => {
    const settings = new PluginSettings();

    await migrateLegacySettings(createApp({ [OCAL_ID]: json({ emptyFolderBehavior: 'Nonsense' }) }), settings);

    expect(settings.emptyFolderBehavior).toBe(EmptyFolderBehavior.Keep);
  });

  it('should union the path lists rather than let one consumer win', async () => {
    const settings = new PluginSettings();
    const app = createApp({
      [OBML_ID]: json({ excludePaths: ['shared', 'obml-only'] }),
      [OCAL_ID]: json({ excludePaths: ['ocal-only', 'shared'], includePaths: ['notes'] })
    });

    await migrateLegacySettings(app, settings);

    expect(settings.excludePaths).toEqual(['ocal-only', 'shared', 'obml-only']);
    expect(settings.includePaths).toEqual(['notes']);
  });

  it('should union the treat-as-attachment extensions without duplicating the default', async () => {
    const settings = new PluginSettings();
    const app = createApp({
      [OCAAL_ID]: json({ treatAsAttachmentExtensions: ['.excalidraw.md', '.canvas.md'] })
    });

    await migrateLegacySettings(app, settings);

    expect(settings.treatAsAttachmentExtensions).toEqual(['.excalidraw.md', '.canvas.md']);
  });

  it('should union the note priorities', async () => {
    const settings = new PluginSettings();

    await migrateLegacySettings(createApp({ [OCAL_ID]: json({ notePriorities: ['.md'] }) }), settings);

    expect(settings.notePriorities).toEqual(['.md']);
  });

  it('should skip a data.json that is not valid JSON', async () => {
    const settings = new PluginSettings();

    const result = await migrateLegacySettings(createApp({ [OCAL_ID]: 'not json' }), settings);

    expect(result.importedFromPluginIds).toEqual([]);
  });

  it('should skip a data.json that holds something other than an object', async () => {
    const settings = new PluginSettings();

    const result = await migrateLegacySettings(createApp({ [OCAL_ID]: json([1, 2, 3]) }), settings);

    expect(result.importedFromPluginIds).toEqual([]);
  });

  it('should skip a data.json holding null', async () => {
    const settings = new PluginSettings();

    const result = await migrateLegacySettings(createApp({ [OCAL_ID]: 'null' }), settings);

    expect(result.importedFromPluginIds).toEqual([]);
  });

  it('should ignore keys whose values are the wrong shape', async () => {
    const settings = new PluginSettings();
    const app = createApp({
      [OCAL_ID]: json({
        excludePaths: 'not-an-array',
        notePriorities: [1, 2],
        shouldHandleRenames: 'yes',
        treatAsAttachmentExtensions: [{}]
      })
    });

    await migrateLegacySettings(app, settings);

    expect(settings.excludePaths).toEqual([]);
    expect(settings.notePriorities).toEqual([]);
    expect(settings.treatAsAttachmentExtensions).toEqual(['.excalidraw.md']);
  });
});
