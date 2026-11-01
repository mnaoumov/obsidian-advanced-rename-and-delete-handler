import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * This plugin opts the shared vault adapter into `@mnaoumov/obsidian-lib`'s `RmdirGuardComponent`, because
 * folder deletion is its concern. Without the guard the two adapters get a non-recursive `rmdir` wrong in
 * opposite directions: the mobile one deletes a non-empty folder with everything in it, and the desktop one
 * refuses even an empty folder. This suite pins the behavior the user gets on both, through the real adapter.
 *
 * The populated folder holds only a dot file on purpose. The vault index omits hidden entries, so a guard
 * deciding emptiness from the index would read that folder as empty and delete it — the exact loss the guard
 * exists to prevent.
 *
 * Cross-platform: the data-loss half is the mobile adapter's, and the manifest declares `isDesktopOnly: false`.
 */

interface GuardResult {
  readonly doesEmptyFolderExist: boolean;
  readonly doesHiddenFileExist: boolean;
  readonly doesPopulatedFolderExist: boolean;
  readonly refusalCode: unknown;
}

describe('The rmdir guard', () => {
  it('refuses a non-recursive rmdir of a folder holding only a hidden file, and removes an empty folder', async () => {
    const result = await evalInObsidian({
      async callback({ app }): Promise<GuardResult> {
        const ROOT = 'rdh-rmdir-guard';
        const POPULATED = `${ROOT}/populated`;
        const HIDDEN_FILE = `${POPULATED}/.hidden`;
        const EMPTY = `${ROOT}/empty`;

        const adapter = app.vault.adapter;
        try {
          // Through the adapter, so the fixture never enters the vault index, the way a hidden file does not.
          await adapter.mkdir(POPULATED);
          await adapter.write(HIDDEN_FILE, 'kept');
          await adapter.mkdir(EMPTY);

          let refusalCode: unknown = null;
          try {
            await adapter.rmdir(POPULATED, false);
          } catch (error) {
            refusalCode = error instanceof Error && 'code' in error ? error.code : error;
          }

          await adapter.rmdir(EMPTY, false);

          return {
            doesEmptyFolderExist: await adapter.exists(EMPTY),
            doesHiddenFileExist: await adapter.exists(HIDDEN_FILE),
            doesPopulatedFolderExist: await adapter.exists(POPULATED),
            refusalCode
          };
        } finally {
          if (await adapter.exists(ROOT)) {
            await adapter.rmdir(ROOT, true);
          }
        }
      }
    });

    expect(result.refusalCode).toBe('ENOTEMPTY');
    expect(result.doesPopulatedFolderExist).toBe(true);
    expect(result.doesHiddenFileExist).toBe(true);
    expect(result.doesEmptyFolderExist).toBe(false);
  });
});
