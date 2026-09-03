/**
 * @file
 *
 * Sweeps the whole vault for folders holding nothing, the manual counterpart to the `emptyFolderBehavior`
 * this plugin already applies after every rename and delete.
 *
 * Two things here are decisions rather than mechanics, and both are easy to undo by accident:
 *
 * **The sweep runs even under `EmptyFolderBehavior.Keep`.** That setting governs a folder emptied
 * INCIDENTALLY — by a deletion the user asked for something else. Invoking this command is the user
 * naming the folders themselves, the same reading `DeleteProtectionPatchComponent.replayFolderDeletion`
 * already applies when it deletes the folder the user picked "even under `EmptyFolderBehavior.Keep`". A
 * command called `Delete empty folders` that silently does nothing is the worse answer, and the plugin
 * this sweep is inherited from never gated it on its own equivalent setting, so gating it here would take
 * away something its users have.
 *
 * **`DeleteWithEmptyParents` asks for nothing extra.** It exists because a single deletion sees only the
 * one folder it emptied and has to walk upward to find the rest. A whole-vault pass has no such blind
 * spot: it visits every folder anyway, and deepest-first, so a parent this pass empties is examined on
 * its own turn. Both delete modes therefore converge here. The setting is still passed through rather
 * than ignored, so the two stay one mechanism if the enum ever grows a mode that does differ.
 *
 * The candidates come from `vault.getAllFolders()` rather than a recursive `adapter.list` walk from the
 * vault root. `getAllFolders` returns the INDEXED folders, which is what keeps `.obsidian`, `.trash` and
 * every other hidden tree off the list — a recursion from the root would descend into all of them.
 * Sorting those folders deepest-first is the same post-order a recursion produces, without the recursion.
 */

import type { App } from 'obsidian';
import type { PluginNoticeComponent } from 'obsidian-dev-utils/obsidian/components/plugin-notice-component';

import { loop } from 'obsidian-dev-utils/obsidian/loop';
import { cleanupEmptyFolders } from 'obsidian-dev-utils/obsidian/vault';

import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';

/**
 * Parameters for {@link deleteEmptyFolders}.
 */
export interface DeleteEmptyFoldersParams {
  /**
   * Cancels the sweep — the plugin unloading, or the user aborting it.
   */
  readonly abortSignal: AbortSignal;

  /**
   * The application instance.
   */
  readonly app: App;

  /**
   * How the vault's empty folders are removed. `Keep` is treated as `Delete`, because the user asked for
   * this sweep by name — see the file comment.
   */
  readonly emptyFolderBehavior: EmptyFolderBehavior;

  /**
   * Whether a path is outside what this plugin is allowed to touch, per its include/exclude lists.
   */
  isPathIgnored(this: void, path: string): boolean;

  /**
   * Shows the sweep's progress.
   */
  readonly pluginNoticeComponent: PluginNoticeComponent;
}

/**
 * Deletes every empty folder in the vault, deepest first.
 *
 * @param params - The vault to sweep, the behavior to apply, and how to report progress.
 */
export async function deleteEmptyFolders(params: DeleteEmptyFoldersParams): Promise<void> {
  const {
    abortSignal,
    app,
    emptyFolderBehavior,
    isPathIgnored,
    pluginNoticeComponent
  } = params;

  const folderPaths = getFolderPathsToSweep(app, isPathIgnored);
  const sweepBehavior = emptyFolderBehavior === EmptyFolderBehavior.DeleteWithEmptyParents
    ? EmptyFolderBehavior.DeleteWithEmptyParents
    : EmptyFolderBehavior.Delete;

  await loop({
    abortSignal,
    buildNoticeMessage: ({ item, iterationString }) => `Checking folder ${iterationString} - ${item}`,
    items: folderPaths,
    pluginNoticeComponent,
    processItem: async (folderPath) => {
      abortSignal.throwIfAborted();
      await cleanupEmptyFolders({
        app,
        emptyFolderBehavior: sweepBehavior,
        folderPaths: [folderPath]
      });
    },
    progressBarTitle: 'Deleting empty folders'
  });
}

/**
 * Counts how deep a path sits below the vault root.
 *
 * @param path - The path to measure.
 * @returns The number of segments in the path.
 */
function getDepth(path: string): number {
  return path.split('/').length;
}

/**
 * Lists the folders the sweep may consider, deepest first.
 *
 * The vault root is excluded outright — a vault with nothing in it is still a vault. Ordering is by depth
 * descending so a folder is always examined after its children, which is what lets a folder holding only
 * empty folders go in the same pass; ties break on the path so the order is stable rather than whatever
 * the index happened to hold.
 *
 * @param app - The application instance.
 * @param isPathIgnored - Whether a path is outside what this plugin may touch.
 * @returns The folder paths to sweep, deepest first.
 */
function getFolderPathsToSweep(app: App, isPathIgnored: (path: string) => boolean): string[] {
  return app.vault.getAllFolders(false)
    .map((folder) => folder.path)
    .filter((folderPath) => !isPathIgnored(folderPath))
    .sort((a, b) => getDepth(b) - getDepth(a) || a.localeCompare(b));
}
