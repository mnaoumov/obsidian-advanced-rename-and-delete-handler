import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * The plugin's central promise, end to end against a real Obsidian: renaming a note rewrites the links
 * pointing at it, and the plugin is the one doing the rewriting.
 *
 * `app.fileManager.renameFile`'s promise can linger on `metadataCache.onCleanCache` in the headless
 * harness, so it is raced against a timeout and the observable effect is polled instead — the same shape
 * the rename suites in the sibling plugins use.
 *
 * Cross-platform: the manifest declares `isDesktopOnly: false`, and renaming a note has to hold on a
 * phone as much as on a desktop, so the file name puts it in both projects.
 */

interface RenameLinkUpdateResult {
  readonly after: string;
  readonly before: string;
  readonly resolvedLinkPath: null | string;
}

describe('Renaming a note', () => {
  it('rewrites the links pointing at it', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }): Promise<RenameLinkUpdateResult> {
        /*
         * Under the transport's ~30s per-closure cap, not at it. The whole closure is one transport call, so
         * what bounds it is the SUM of the four budgets below — 25 200 ms — rather than any one of them. They
         * used to read 40 000 / 6000 / 20 000 / 200, which sums to 66 200: more than twice a cap the call
         * would have been killed at first, and reported as a bare transport timeout naming the harness rather
         * than whichever wait overran.
         *
         * What each one waits on is a two-note vault resolving a single link and then rewriting it, which
         * lands in well under a second, so the smaller numbers cost nothing. There is no long step here to
         * move to `pollInObsidian`.
         */
        const BACKLINK_TIMEOUT_IN_MILLISECONDS = 8000;
        const RENAME_SETTLE_IN_MILLISECONDS = 5000;
        const REWRITE_DEADLINE_IN_MILLISECONDS = 12_000;
        const REWRITE_POLL_INTERVAL_IN_MILLISECONDS = 200;

        const stamp = `${Date.now().toString()}-${Math.floor(performance.now()).toString()}`;
        const folder = `rename-links-${stamp}`;
        const targetPath = `${folder}/target-${stamp}.md`;
        const renamedTargetPath = `${folder}/renamed-${stamp}.md`;
        const sourcePath = `${folder}/source-${stamp}.md`;

        await app.vault.createFolder(folder);
        const target = await app.vault.create(targetPath, '# Target\n');
        const source = await app.vault.create(sourcePath, `[link](<${targetPath}>)\n`);

        // Obsidian otherwise asks for confirmation through a modal, which would stall a headless run.
        app.vault.setConfig('alwaysUpdateLinks', true);

        await waitUntil({
          message: 'the link resolves to the target',
          predicate: () => app.metadataCache.getBacklinksForFile(target).keys().length > 0,
          timeoutInMilliseconds: BACKLINK_TIMEOUT_IN_MILLISECONDS
        });

        const before = await app.vault.read(source);

        const renamePromise = app.fileManager.renameFile(target, renamedTargetPath);
        await Promise.race([
          renamePromise.catch(() => {
            // Lingering `onCleanCache`; the effect is polled below.
          }),
          sleep(RENAME_SETTLE_IN_MILLISECONDS)
        ]);

        // Polled rather than awaited, so a stale link is reported as a failed expectation with both
        // Texts attached rather than as an opaque timeout.
        const deadline = Date.now() + REWRITE_DEADLINE_IN_MILLISECONDS;
        while (Date.now() < deadline) {
          if ((await app.vault.read(source)) !== before) {
            break;
          }
          await sleep(REWRITE_POLL_INTERVAL_IN_MILLISECONDS);
        }

        const after = await app.vault.read(source);

        /*
         * Asserted by RESOLVING the link rather than by matching its text: Obsidian rewrites using the
         * vault's configured link format, so a folder-qualified link legitimately comes back as a
         * shortest-path one. A text assertion would fail on a correct rewrite.
         */
        const links = app.metadataCache.getFileCache(source)?.links ?? [];
        const firstLink = links[0];
        const resolvedLinkPath = firstLink
          ? app.metadataCache.getFirstLinkpathDest(firstLink.link, sourcePath)?.path ?? null
          : null;

        return { after, before, resolvedLinkPath };
      }
    });

    expect(result.after).not.toBe(result.before);
    expect(result.resolvedLinkPath).toMatch(/renamed-/);
  });
});
