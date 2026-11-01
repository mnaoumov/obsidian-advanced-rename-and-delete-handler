import dedent from 'dedent';
import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * Obsidian resolves an HTML `src` like a link path but never updates one, so `shouldUpdateHtmlLinks` does (measured
 * 2026-11-01: a bare name, `./`, a full path and a `/`-rooted path all render the image). This renames an image that
 * a note names four ways, and a note whose own `./` path breaks because the note moved, then waits for the batch to
 * settle and reads the notes back.
 *
 * It runs with renames left to Obsidian, the default: the rewrite does not depend on this plugin's link handler.
 * The setting is not in the published API, so it goes in through `configureCommunityPlugin`, and the closure puts
 * back what `data.json` held.
 *
 * Cross-platform: HTML in notes renders on phones too.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';

interface HtmlLinkUpdateResult {
  readonly movedNoteContent: string;
  readonly noteContent: string;
  readonly noticeTexts: readonly string[];
}

describe('HTML links after a rename', () => {
  it('are rewritten in the style they were written in', async () => {
    const result = await renameAndRead();

    expect(result.noteContent).toBe(`${dedent`
      <img src="photo%20two.png">

      <img src="./photo%20two.png">

      <img src="rdh-html-links/assets/photo two.png">

      <img src="/rdh-html-links/assets/photo two.png">

      \`<img src="photo one.png">\`
    `}\n`);
    expect(result.movedNoteContent).toBe('<img src="../assets/photo%20two.png">\n');
    expect(result.noticeTexts).toEqual([expect.stringContaining('Updated 5 HTML links in 2 files.')]);
  });
});

async function renameAndRead(): Promise<HtmlLinkUpdateResult> {
  return await evalInObsidian({
    async callback({
      app,
      lib: {
        configureCommunityPlugin,
        waitUntil
      },
      pluginId
    }): Promise<HtmlLinkUpdateResult> {
      const FOLDER = 'rdh-html-links';
      /*
       * Under the transport's ~30s per-closure cap, not at it. Charged twice: the image rename's batch and the note
       * move's batch, each settling a second after its last rename.
       */
      const WAIT_TIMEOUT_IN_MILLISECONDS = 10_000;

      const dataPath = `${app.vault.configDir}/plugins/${pluginId}/data.json`;
      const originalData = await app.vault.adapter.exists(dataPath)
        ? JSON.parse(await app.vault.adapter.read(dataPath)) as Record<string, unknown>
        : {};
      const originalShouldUpdateHtmlLinks = originalData['shouldUpdateHtmlLinks'] ?? false;

      try {
        await configureCommunityPlugin({
          app,
          pluginId,
          settings: { shouldUpdateHtmlLinks: true }
        });

        await app.vault.createFolder(`${FOLDER}/assets`);
        await app.vault.createFolder(`${FOLDER}/notes`);
        const image = await app.vault.createBinary(`${FOLDER}/assets/photo one.png`, new ArrayBuffer(8));
        const note = await app.vault.create(
          `${FOLDER}/assets/note.md`,
          [
            '<img src="photo%20one.png">',
            '',
            '<img src="./photo%20one.png">',
            '',
            `<img src="${FOLDER}/assets/photo one.png">`,
            '',
            `<img src="/${FOLDER}/assets/photo one.png">`,
            '',
            '`<img src="photo one.png">`',
            ''
          ].join('\n')
        );
        const movingNote = await app.vault.create(`${FOLDER}/assets/moving.md`, '<img src="./photo%20one.png">\n');
        const noteContentBefore = await app.vault.read(note);
        const noticesBefore = new Set(document.querySelectorAll('.notice'));

        await app.fileManager.renameFile(image, `${FOLDER}/assets/photo two.png`);
        await app.fileManager.renameFile(movingNote, `${FOLDER}/notes/moving.md`);
        await waitUntil({
          message: 'the HTML links are rewritten once the batch settles',
          predicate: async () => {
            const noteContent = await app.vault.read(note);
            const movingNoteContent = await app.vault.read(movingNote);
            return noteContent !== noteContentBefore && movingNoteContent.includes('photo%20two');
          },
          timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
        });
        await waitUntil({
          message: 'the notice is shown',
          predicate: () => [...document.querySelectorAll('.notice')].some((noticeEl) => !noticesBefore.has(noticeEl)),
          timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
        });

        return {
          movedNoteContent: await app.vault.read(movingNote),
          noteContent: await app.vault.read(note),
          noticeTexts: [...document.querySelectorAll('.notice')]
            .filter((noticeEl) => !noticesBefore.has(noticeEl))
            .map((noticeEl) => noticeEl.textContent)
            .filter((text) => text.includes('HTML'))
        };
      } finally {
        await configureCommunityPlugin({
          app,
          pluginId,
          settings: { shouldUpdateHtmlLinks: originalShouldUpdateHtmlLinks }
        });
        // Through the adapter, so the teardown does not travel back through the delete path this plugin patches.
        if (await app.vault.adapter.exists(FOLDER)) {
          await app.vault.adapter.rmdir(FOLDER, true);
        }
      }
    },
    input: {
      pluginId: PLUGIN_ID
    }
  });
}
