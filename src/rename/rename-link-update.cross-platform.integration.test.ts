import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * The plugin's central promise, end to end against a real Obsidian: renaming a note rewrites the links
 * pointing at it. The suite writes no settings, so it runs on the defaults, where `shouldHandleRenames` is
 * off and Obsidian does the rewriting: what it pins is that the plugin, loaded, does not get in the way.
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
  readonly stallReport: string;
}

describe('Renaming a note', () => {
  it('rewrites the links pointing at it', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }): Promise<RenameLinkUpdateResult> {
        /*
         * Under the transport's ~30s per-closure cap, not at it. The whole closure is one transport call, so
         * what bounds it is the SUM of the five budgets below — 25 200 ms — rather than any one of them. They
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
        const REWRITE_DEADLINE_IN_MILLISECONDS = 8000;
        const REWRITE_POLL_INTERVAL_IN_MILLISECONDS = 200;
        const CACHE_REPARSE_TIMEOUT_IN_MILLISECONDS = 4000;

        const stamp = `${Date.now().toString()}-${Math.floor(performance.now()).toString()}`;
        const folder = `rename-links-${stamp}`;
        const targetPath = `${folder}/target-${stamp}.md`;
        const renamedTargetPath = `${folder}/renamed-${stamp}.md`;
        const sourcePath = `${folder}/source-${stamp}.md`;

        await app.vault.createFolder(folder);
        const target = await app.vault.create(targetPath, '# Target\n');
        const source = await app.vault.create(sourcePath, `[link](<${targetPath}>)\n`);

        await waitUntil({
          message: 'the link resolves to the target',
          predicate: () => app.metadataCache.getBacklinksForFile(target).keys().length > 0,
          timeoutInMilliseconds: BACKLINK_TIMEOUT_IN_MILLISECONDS
        });

        const before = await app.vault.read(source);

        let renameOutcome = 'still pending';
        const renamePromise = app.fileManager.renameFile(target, renamedTargetPath)
          .then(() => {
            renameOutcome = 'resolved';
          })
          .catch((error: unknown) => {
            renameOutcome = `rejected: ${String(error)}`;
          });
        await Promise.race([renamePromise, sleep(RENAME_SETTLE_IN_MILLISECONDS)]);

        /*
         * Polled rather than awaited, so a stale link is reported as a failed expectation with both
         * texts attached rather than as an opaque timeout. The longest gap between two polls is kept
         * because a renderer that froze past the deadline also reads as a link that was never rewritten.
         */
        const deadline = Date.now() + REWRITE_DEADLINE_IN_MILLISECONDS;
        let lastPollTime = Date.now();
        let longestPollGapInMilliseconds = 0;
        while (Date.now() < deadline) {
          if ((await app.vault.read(source)) !== before) {
            break;
          }
          await sleep(REWRITE_POLL_INTERVAL_IN_MILLISECONDS);
          longestPollGapInMilliseconds = Math.max(longestPollGapInMilliseconds, Date.now() - lastPollTime);
          lastPollTime = Date.now();
        }

        const after = await app.vault.read(source);

        /*
         * With the plugin's default settings the rewrite is Obsidian's own: `renameFile` queues a link
         * update on `fileManager`, which waits for a clean metadata cache and then rewrites every link
         * it collected, asking first unless `alwaysUpdateLinks` is on. A rewrite measures 40-60 ms on
         * the Android emulator, so a link still stale here is a stall, and this says which part stalled.
         * The prompt is reported by its modal rather than by the setting, because the setting read back
         * here need not be the one the rename saw: a write to `app.json` from outside Obsidian's adapter
         * makes Obsidian reload the file, and that brings back whatever is on disk.
         */
        const { fileManager, metadataCache } = app;
        const cacheState = metadataCache.isCacheClean() ? 'clean' : 'NOT clean';
        const taskCount = String(metadataCache.inProgressTaskCount);
        const resolutionCount = String(metadataCache.linkResolverQueue?.items.length ?? 0);
        const waiterCount = String(metadataCache.onCleanCacheCallbacks.length);
        const stallReport = after === before
          ? [
            `renameFile ${renameOutcome}`,
            `target at ${target.path}`,
            `metadata cache ${cacheState} (${taskCount} task(s) in progress, ${resolutionCount} link resolution(s) queued, ${waiterCount} waiter(s))`,
            `link update ${fileManager.inProgressUpdates === null ? 'not running' : 'running'}`,
            `modal ${document.querySelector('.modal-container')?.textContent ?? 'none'}`,
            `longest gap between polls ${String(longestPollGapInMilliseconds)} ms`
          ].join('; ')
          : '';

        /*
         * Asserted by RESOLVING the link rather than by matching its text: Obsidian rewrites using the
         * vault's configured link format, so a folder-qualified link legitimately comes back as a
         * shortest-path one. A text assertion would fail on a correct rewrite.
         *
         * The text on disk changing does not mean the metadata cache has re-parsed it: until it does, the
         * cache still holds the OLD link, whose target no longer exists, and it resolves to `null`. So the
         * cached link is waited on first. A timeout here falls through, so a link that never resolves is
         * still reported by the expectation below rather than as a bare wait failure.
         */
        function resolveFirstLink(): null | string {
          const firstLink = app.metadataCache.getFileCache(source)?.links?.[0];
          return firstLink
            ? app.metadataCache.getFirstLinkpathDest(firstLink.link, sourcePath)?.path ?? null
            : null;
        }

        try {
          await waitUntil({
            message: 'the metadata cache holds the rewritten link',
            predicate: () => resolveFirstLink() !== null,
            timeoutInMilliseconds: CACHE_REPARSE_TIMEOUT_IN_MILLISECONDS
          });
        } catch {
          // Reported by the expectation on `resolvedLinkPath`.
        }

        const resolvedLinkPath = resolveFirstLink();

        return { after, before, resolvedLinkPath, stallReport };
      }
    });

    expect(result.after, result.stallReport).not.toBe(result.before);
    expect(result.resolvedLinkPath).toMatch(/renamed-/);
  });
});
