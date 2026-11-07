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
 * Renaming a canvas whose text nodes each embed several attachments renames the attachments and leaves every
 * node's text intact, each embed pointing at its attachment's new name (issue #10).
 *
 * The reporter's canvas had six text nodes: two tables of embeds, wikilinks and markdown links, and four runs of
 * embeds with and without blank lines between them. With attachment renaming on, renaming the canvas renamed the
 * attachments but left the tables and links broken. The staging below is the reporter's, three embeds a node, and
 * a stub `Custom Attachment Location` API stands in for that plugin's `{{noteFileName}} - <date>` names: it
 * answers a renamed note's attachment with the note's new name in place of its old one.
 *
 * Cross-platform: a canvas renames the same way on a phone, and the manifest declares `isDesktopOnly: false`.
 */

interface AttachmentPathParamsLike {
  readonly attachmentFileBaseName: string;
  readonly attachmentFileExtension: string;
  readonly notePathOrFile: null | PathHolder | string;
  readonly oldNotePathOrFile?: null | PathHolder | string;
}

interface CanvasDataLike {
  readonly nodes: readonly CanvasNodeLike[];
}

interface CanvasNodeLike {
  readonly text?: string;
}

interface CanvasRenameResult {
  readonly attachmentPaths: string[];
  readonly expectedTexts: string[];
  readonly texts: string[];
}

interface PathHolder {
  readonly path: string;
}

let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
  await writePluginSettings({ ...originalSettings, shouldHandleRenames: true, shouldRenameAttachmentFiles: true });
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('Renaming a canvas whose text nodes embed several attachments', () => {
  it('renames the attachments and rewrites every embed without breaking the text', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { castTo, ComponentEx, flushQueue, publishPluginApi, waitUntil } }): Promise<CanvasRenameResult> {
        // Under the transport's ~30s per-closure cap, not at it: two waits of 8 000 ms and one of 2 000 ms.
        const WAIT_TIMEOUT_IN_MILLISECONDS = 8000;
        const INDEX_TIMEOUT_IN_MILLISECONDS = 2000;
        const root = `rdh-canvas-multiple-links-${Date.now().toString()}`;
        const oldCanvasPath = `${root}/canvas.canvas`;
        const newCanvasPath = `${root}/board.canvas`;
        const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');
        const originalLinkFormat = app.vault.getConfig('newLinkFormat');
        const originalUseMarkdownLinks = app.vault.getConfig('useMarkdownLinks');
        const stubOwner = new ComponentEx();

        function getPathOf(pathOrFile: null | PathHolder | string | undefined): string {
          return typeof pathOrFile === 'string' ? pathOrFile : pathOrFile?.path ?? '';
        }

        function getBaseName(path: string): string {
          return (path.split('/').at(-1) ?? '').replace(/\.[^.]*$/, '');
        }

        const stamps = Array.from({ length: 18 }, (_, index) => `202611071510${String(index).padStart(5, '0')}`);
        function wikilink(stamp: string, name: string, divider: string): string {
          return `![[${name} - ${stamp}.png${divider}500]]`;
        }

        function markdownLink(stamp: string, name: string): string {
          return `![500](${encodeURIComponent(`${name} - ${stamp}.png`)})`;
        }

        function buildTexts(name: string): string[] {
          const [first = [], second = [], third = [], fourth = [], fifth = [], sixth = []] = [0, 3, 6, 9, 12, 15].map((start) => stamps.slice(start, start + 3));
          return [
            `table with images - **wikilinks**\n\n\n| ${first.map((stamp) => wikilink(stamp, name, '\\|')).join(' | ')} |\n| --- | --- | --- |\n`,
            `table with images - **markdown links**\n\n| ${second.map((stamp) => markdownLink(stamp, name)).join(' | ')} |\n| --- | --- | --- |\n`,
            `images - **wikilinks** - with line breaks\n\n${third.map((stamp) => wikilink(stamp, name, '|')).join('\n\n')}`,
            `images - **wikilinks** - without line breaks\n${fourth.map((stamp) => wikilink(stamp, name, '|')).join('\n')}`,
            `images - **markdown links** - with line breaks\n\n${fifth.map((stamp) => markdownLink(stamp, name)).join('\n\n')}`,
            `images - **markdown links** - without line breaks\n${sixth.map((stamp) => markdownLink(stamp, name)).join('\n')}`
          ];
        }

        async function readTexts(): Promise<string[]> {
          const canvas = app.vault.getFileByPath(newCanvasPath) ?? app.vault.getFileByPath(oldCanvasPath);
          if (!canvas) {
            return [];
          }
          const canvasData = JSON.parse(await app.vault.read(canvas)) as CanvasDataLike;
          return canvasData.nodes.map((node) => node.text ?? '');
        }

        try {
          app.vault.setConfig('attachmentFolderPath', './attachments');
          app.vault.setConfig('newLinkFormat', 'shortest');
          app.vault.setConfig('useMarkdownLinks', true);
          // Saved at once, so a reload of `app.json` mid-case cannot put back what the handler reads.
          await app.vault.saveConfig();

          stubOwner.load();
          publishPluginApi({
            api: {
              getAvailablePathForAttachments: (params: AttachmentPathParamsLike): Promise<string> => {
                const notePath = getPathOf(params.notePathOrFile);
                const oldNoteBaseName = getBaseName(getPathOf(params.oldNotePathOrFile));
                const noteFolderPath = notePath.split('/').slice(0, -1).join('/');
                const baseName = oldNoteBaseName && params.attachmentFileBaseName.startsWith(`${oldNoteBaseName} - `)
                  ? `${getBaseName(notePath)}${params.attachmentFileBaseName.slice(oldNoteBaseName.length)}`
                  : params.attachmentFileBaseName;
                const extension = params.attachmentFileExtension ? `.${params.attachmentFileExtension}` : '';
                return Promise.resolve(`${noteFolderPath}/attachments/${baseName}${extension}`);
              },
              isAttachmentUnitFolder: (): boolean => false
            },
            apiVersion: '1.3.0',
            component: stubOwner,
            plugin: castTo<Plugin>({ manifest: { id: 'obsidian-custom-attachment-location' } })
          });

          await app.vault.createFolder(`${root}/attachments`);
          for (const stamp of stamps) {
            await app.vault.createBinary(`${root}/attachments/canvas - ${stamp}.png`, new ArrayBuffer(8));
          }

          const canvas = await app.vault.create(
            oldCanvasPath,
            JSON.stringify(
              {
                edges: [],
                nodes: buildTexts('canvas').map((text, index) => ({
                  height: 500,
                  id: `node${String(index)}`,
                  text,
                  type: 'text',
                  width: 400,
                  x: index * 500,
                  y: 0
                }))
              },
              null,
              '\t'
            )
          );

          const canvasIndex = app.internalPlugins.getPluginById('canvas')?.instance.index;
          if (!canvasIndex) {
            throw new Error('the Canvas core plugin is not enabled');
          }

          await waitUntil({
            message: 'Obsidian\'s canvas index holds the canvas',
            predicate: () => canvasIndex.index[oldCanvasPath] !== undefined,
            timeoutInMilliseconds: INDEX_TIMEOUT_IN_MILLISECONDS
          });

          await app.fileManager.renameFile(canvas, newCanvasPath);

          await waitUntil({
            message: 'every attachment has taken the canvas\'s new name',
            predicate: () => stamps.every((stamp) => app.vault.getFileByPath(`${root}/attachments/board - ${stamp}.png`) !== null),
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          }).catch(() => undefined);
          // Drained after the effect, not before it: see `canvas-partial-write-guard`.
          await flushQueue();
          await waitUntil({
            message: 'the canvas names no old attachment',
            predicate: async () => {
              const texts = await readTexts();
              return texts.every((text) => !text.includes('canvas - ') && !text.includes('canvas%20'));
            },
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          }).catch(() => undefined);
          await flushQueue();

          return {
            attachmentPaths: (app.vault.getFolderByPath(`${root}/attachments`)?.children ?? []).map((child) => child.path).sort(),
            expectedTexts: buildTexts('board'),
            texts: await readTexts()
          };
        } finally {
          await flushQueue();
          stubOwner.unload();
          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
          app.vault.setConfig('newLinkFormat', originalLinkFormat);
          app.vault.setConfig('useMarkdownLinks', originalUseMarkdownLinks);
          await app.vault.saveConfig();
          if (await app.vault.adapter.exists(root)) {
            await app.vault.adapter.rmdir(root, true);
          }
        }
      }
    });

    expect(result.attachmentPaths.every((path) => path.includes('/attachments/board - '))).toBe(true);
    expect(result.texts).toEqual(result.expectedTexts);
  });
});
