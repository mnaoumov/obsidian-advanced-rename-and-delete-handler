import type { Plugin } from 'obsidian';

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
 * A mass rename of 2,839 notes renamed some of a note's link targets and then, shortly after, the note itself.
 * Three of that note's links were left at their targets' old names. Each target's handler captures, in the
 * `rename` event, which notes link to the target, and rewrites them later, from the serial queue. A linking
 * note renamed in between was no longer at the path the handler had captured, so its rewrite was skipped
 * without a word.
 *
 * Two windows, one case each. The first holds the queue, so every target's handler starts after the note has
 * moved. The second stops one handler halfway, inside the attachment-path question it puts to a stub
 * `Custom Attachment Location` API after it has refreshed its backlinks, and renames the note there. The
 * refresh at the start of a handler always covered the first window; only the second ever lost a link, and
 * it is the one a long run of renames hits, because the next rename lands while the previous handler runs.
 */

interface AttachmentPathParamsLike {
  readonly attachmentFileBaseName: string;
  readonly attachmentFileExtension: string;
  readonly notePathOrFile: null | PathHolder | string;
}

interface HolderResult {
  readonly content: string;
  readonly resolvedLinks: (null | string)[];
}

interface PathHolder {
  readonly path: string;
}

let originalSettings: PluginSettingsSnapshot;
beforeAll(async () => {
  originalSettings = await readPluginSettings();
  await writePluginSettings({ ...originalSettings, shouldHandleRenames: true, shouldRenameAttachmentFolder: true });
});
afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('a note renamed while the handlers of its link targets are pending', () => {
  it('has every link rewritten when the handlers start after it moved', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { addToQueue, flushQueue, waitUntil } }): Promise<HolderResult> {
        // Under the transport's ~30s per-closure cap, not at it.
        const WAIT_TIMEOUT_IN_MILLISECONDS = 8000;
        const root = `renamed-holder-queued-${Date.now().toString()}`;
        const targetNames = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
        const renamedTargetNames = ['Alpha', 'Bravo', 'Charlie'];
        const originalLinkFormat = app.vault.getConfig('newLinkFormat');
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        try {
          app.vault.setConfig('newLinkFormat', 'relative');
          await app.vault.saveConfig();
          await app.vault.createFolder(root);
          for (const name of targetNames) {
            await app.vault.create(`${root}/old ${name}.md`, `# ${name}\n`);
          }
          const holder = await app.vault.create(
            `${root}/old Holder.md`,
            `${targetNames.map((name) => `[${name}](<./old ${name}.md>)`).join('\n')}\n`
          );
          await waitUntil({
            message: 'every link of the holder resolves',
            predicate: () => (app.metadataCache.getFileCache(holder)?.links ?? []).filter((link) => app.metadataCache.getFirstLinkpathDest(link.link, holder.path) !== null).length === targetNames.length,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          addToQueue({ operationFunction: () => gate, operationName: 'Hold the queue' });

          for (const name of renamedTargetNames) {
            const target = app.vault.getFileByPath(`${root}/old ${name}.md`);
            if (!target) {
              throw new Error(`No ${name} target`);
            }
            await app.fileManager.renameFile(target, `${root}/new ${name}.md`);
          }
          await app.fileManager.renameFile(holder, `${root}/new Holder.md`);
          release?.();

          await waitUntil({
            message: 'the queued handlers have rewritten the holder',
            predicate: async () => {
              const content = await app.vault.read(holder);
              return renamedTargetNames.every((name) => content.includes(`new ${name}`));
            },
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          }).catch(() => undefined);
          await flushQueue();
          return {
            content: await app.vault.read(holder),
            resolvedLinks: (app.metadataCache.getFileCache(holder)?.links ?? []).map((link) => app.metadataCache.getFirstLinkpathDest(link.link, holder.path)?.path ?? null)
          };
        } finally {
          release?.();
          await flushQueue();
          app.vault.setConfig('newLinkFormat', originalLinkFormat);
          await app.vault.saveConfig();
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      }
    });
    expect(result.content).not.toContain('old Alpha');
    expect(result.content).not.toContain('old Bravo');
    expect(result.content).not.toContain('old Charlie');
    expect(result.resolvedLinks).not.toContain(null);
  });

  it('has the link rewritten when it moves while a target\'s handler is halfway', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { castTo, ComponentEx, flushQueue, publishPluginApi, waitUntil } }): Promise<HolderResult> {
        // Under the transport's ~30s per-closure cap, not at it.
        const WAIT_TIMEOUT_IN_MILLISECONDS = 6000;
        const root = `renamed-holder-in-flight-${Date.now().toString()}`;
        const oldTargetPath = `${root}/old Alpha.md`;
        const newTargetPath = `${root}/new Alpha.md`;
        const originalLinkFormat = app.vault.getConfig('newLinkFormat');
        const stubOwner = new ComponentEx();
        let release: (() => void) | undefined;
        let isHandlerHalfway = false;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        try {
          app.vault.setConfig('newLinkFormat', 'relative');
          await app.vault.saveConfig();
          await app.vault.createFolder(root);
          const target = await app.vault.create(oldTargetPath, '# Alpha\n');
          const holder = await app.vault.create(`${root}/old Holder.md`, '[Alpha](<./old Alpha.md>)\n');
          await waitUntil({
            message: 'the link of the holder resolves',
            predicate: () => app.metadataCache.getBacklinksForFile(target).keys().length > 0,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          /*
           * Stands in for an installed `Custom Attachment Location`. The target's handler asks it where the
           * target's attachments go after it has refreshed its backlinks and before it rewrites them, so
           * holding that one answer holds the handler exactly in the window that lost links.
           */
          stubOwner.load();
          publishPluginApi({
            api: {
              getAvailablePathForAttachments: async (params: AttachmentPathParamsLike): Promise<string> => {
                const notePath = typeof params.notePathOrFile === 'string' ? params.notePathOrFile : params.notePathOrFile?.path ?? '';
                if (notePath === oldTargetPath || notePath === newTargetPath) {
                  isHandlerHalfway = true;
                  await gate;
                }
                const noteFolderPath = notePath.split('/').slice(0, -1).join('/');
                const extension = params.attachmentFileExtension ? `.${params.attachmentFileExtension}` : '';
                return `${noteFolderPath}/assets/${params.attachmentFileBaseName}${extension}`;
              },
              isAttachmentUnitFolder: (): boolean => false
            },
            apiVersion: '1.3.0',
            component: stubOwner,
            plugin: castTo<Plugin>({ manifest: { id: 'obsidian-custom-attachment-location' } })
          });

          await app.fileManager.renameFile(target, newTargetPath);
          await waitUntil({
            message: 'the target\'s handler asks where its attachments go',
            predicate: () => isHandlerHalfway,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });
          await app.fileManager.renameFile(holder, `${root}/new Holder.md`);
          release?.();

          await waitUntil({
            message: 'the target\'s handler has rewritten the holder',
            predicate: async () => {
              const content = await app.vault.read(holder);
              return content.includes('new Alpha');
            },
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          }).catch(() => undefined);
          await flushQueue();
          return {
            content: await app.vault.read(holder),
            resolvedLinks: (app.metadataCache.getFileCache(holder)?.links ?? []).map((link) => app.metadataCache.getFirstLinkpathDest(link.link, holder.path)?.path ?? null)
          };
        } finally {
          release?.();
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
    expect(result.content).toBe('[Alpha](<./new Alpha.md>)\n');
    expect(result.resolvedLinks).toEqual([expect.stringMatching(/\/new Alpha\.md$/)]);
  });
});
