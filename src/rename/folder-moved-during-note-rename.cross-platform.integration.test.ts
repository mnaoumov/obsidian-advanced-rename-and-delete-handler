import type {
  EventRef,
  Plugin
} from 'obsidian';

import { evalInObsidian } from 'obsidian-integration-testing';
import {
  afterAll,
  beforeAll,
  expect,
  it
} from 'vitest';

import type { PluginSettingsSnapshot } from '../settings/settings-snapshot.integration-helper.ts';

import {
  readPluginSettings,
  writePluginSettings
} from '../settings/settings-snapshot.integration-helper.ts';

/*
 * Issue #11. `Folder notes` with `syncFolderName` renames a folder note's folder from its own `rename` handler,
 * without awaiting it, when the folder note is renamed. The folder therefore moves before this plugin's queued
 * handler for the note's rename gets to run, and that handler looked for the note's attachment folder where it
 * was before the folder moved, found nothing, and moved nothing.
 *
 * The suite stands in for both plugins: a `rename` listener renames the parent folder the way `Folder notes`
 * does, and a stub `Custom Attachment Location` API gives every note its own attachment folder, as the
 * reporter's `./_resources/{{noteFileName}}` does.
 */

interface AttachmentPathParamsLike {
  readonly attachmentFileBaseName: string;
  readonly attachmentFileExtension: string;
  readonly notePathOrFile: null | PathHolder | string;
}

interface PathHolder {
  readonly path: string;
}

interface Result {
  readonly content: null | string;
  readonly files: string[];
  readonly resolvedEmbeds: (null | string)[];
}

let originalSettings: PluginSettingsSnapshot;
beforeAll(async () => {
  originalSettings = await readPluginSettings();
  await writePluginSettings({
    ...originalSettings,
    shouldHandleRenames: true,
    shouldRenameAttachmentFiles: false,
    shouldRenameAttachmentFolder: true
  });
});
afterAll(async () => {
  await writePluginSettings(originalSettings);
});

it('moves the attachment folder of a folder note whose folder is renamed while its rename is handled', async () => {
  const result = await evalInObsidian({
    async callback({ app, lib: { castTo, ComponentEx, flushQueue, publishPluginApi, waitUntil } }): Promise<Result> {
      // Under the transport's ~30s per-closure cap, not at it.
      const WAIT_TIMEOUT_IN_MILLISECONDS = 8000;
      const root = `folder-moved-during-note-rename-${Date.now().toString()}`;
      const oldNotePath = `${root}/d/d-Index.md`;
      const renamedNotePath = `${root}/d/e-Index.md`;
      const finalNotePath = `${root}/e/e-Index.md`;
      const expectedAttachmentPath = `${root}/e/_resources/e-Index/pic3.png`;
      const originalLinkFormat = app.vault.getConfig('newLinkFormat');
      const stubOwner = new ComponentEx();
      let eventRef: EventRef | null = null;
      try {
        app.vault.setConfig('newLinkFormat', 'relative');
        await app.vault.saveConfig();

        stubOwner.load();
        publishPluginApi({
          api: {
            getAvailablePathForAttachments: (params: AttachmentPathParamsLike): string => {
              const notePath = typeof params.notePathOrFile === 'string' ? params.notePathOrFile : params.notePathOrFile?.path ?? '';
              const segments = notePath.split('/');
              const noteFileName = (segments.pop() ?? '').replace(/\.md$/, '');
              const extension = params.attachmentFileExtension ? `.${params.attachmentFileExtension}` : '';
              return `${[...segments, '_resources', noteFileName].join('/')}/${params.attachmentFileBaseName}${extension}`;
            },
            isAttachmentUnitFolder: (): boolean => false
          },
          apiVersion: '1.3.0',
          component: stubOwner,
          plugin: castTo<Plugin>({ manifest: { id: 'obsidian-custom-attachment-location' } })
        });

        await app.vault.createFolder(`${root}/d/_resources/d-Index`);
        await app.vault.createBinary(`${root}/d/_resources/d-Index/pic3.png`, new Uint8Array([137, 80, 78, 71]).buffer);
        const note = await app.vault.create(oldNotePath, '![](<./_resources/d-Index/pic3.png>)\n');
        await waitUntil({
          message: 'the embed of the folder note resolves',
          predicate: () => (app.metadataCache.getFileCache(note)?.embeds ?? []).some((embed) => app.metadataCache.getFirstLinkpathDest(embed.link, note.path) !== null),
          timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
        });

        // What `Folder notes` does with `syncFolderName`: rename the folder from the note's `rename` event, without awaiting it.
        eventRef = app.vault.on('rename', (file, oldPath) => {
          if (oldPath !== oldNotePath || file.path !== renamedNotePath) {
            return;
          }
          const folder = app.vault.getFolderByPath(`${root}/d`);
          if (folder) {
            app.fileManager.renameFile(folder, `${root}/e`).catch((error: unknown) => {
              console.error(error);
            });
          }
        });

        await app.fileManager.renameFile(note, renamedNotePath);

        await waitUntil({
          message: 'the attachment has moved to the renamed note\'s attachment folder',
          predicate: () => app.vault.getFileByPath(expectedAttachmentPath) !== null,
          timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
        }).catch(() => undefined);
        await flushQueue();

        const finalNote = app.vault.getFileByPath(finalNotePath);
        return {
          content: finalNote ? await app.vault.read(finalNote) : null,
          files: app.vault.getFiles().map((file) => file.path).filter((path) => path.startsWith(`${root}/`)).sort(),
          resolvedEmbeds: finalNote
            ? (app.metadataCache.getFileCache(finalNote)?.embeds ?? []).map((embed) => app.metadataCache.getFirstLinkpathDest(embed.link, finalNote.path)?.path ?? null)
            : []
        };
      } finally {
        if (eventRef) {
          app.vault.offref(eventRef);
        }
        await flushQueue();
        stubOwner.unload();
        app.vault.setConfig('newLinkFormat', originalLinkFormat);
        await app.vault.saveConfig();
        const folder = app.vault.getFolderByPath(root);
        if (folder) {
          await app.fileManager.trashFile(folder);
        }
      }
    }
  });
  const root = result.files[0]?.split('/', 1)[0] ?? '';
  expect(result.files).toEqual([
    `${root}/e/_resources/e-Index/pic3.png`,
    `${root}/e/e-Index.md`
  ]);
  expect(result.content).toBe('![](<./_resources/e-Index/pic3.png>)\n');
  expect(result.resolvedEmbeds).toEqual([`${root}/e/_resources/e-Index/pic3.png`]);
});
