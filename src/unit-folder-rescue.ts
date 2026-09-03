/**
 * @file
 *
 * Works out which folder a rescue has to move, when the attachment it is rescuing is only one file of a
 * tree that has to travel whole.
 *
 * Kept separate from `rename-delete-handler-component.ts` for the same reason `rescue-decision-scope.ts`
 * is: that file sits inside a `v8 ignore` region, and this decision is worth holding to the enforced
 * coverage. It is deliberately pure — the caller resolves the folder, moves it, and reports it.
 */

import {
  basename,
  dirname,
  join
} from 'obsidian-dev-utils/path';

import type { RescueDestination } from './rename-delete-handler-component.ts';

/**
 * Parameters for {@link planUnitFolderMove}.
 */
export interface PlanUnitFolderMoveParams {
  /**
   * Where the attachment belongs, as the consuming plugin answered.
   */
  readonly rescueDestination: RescueDestination;

  /**
   * The folder the deletion is walking — the folder the user named, or the deleted note's own attachment
   * folder.
   */
  readonly rootFolderPath: string;
}

/**
 * A folder move a rescue has to perform before the deletion walks the tree.
 */
export interface UnitFolderMove {
  /**
   * Where the folder has to end up.
   */
  readonly newFolderPath: string;

  /**
   * The folder to move.
   */
  readonly oldFolderPath: string;
}

/**
 * Plans the folder move that keeps an attachment unit whole while its owning note's area is deleted.
 *
 * The folder lands under its own name inside the attachment folder the lone file would have gone to, so
 * the tree's internal shape — and the relative links inside it — survive the move. This is the same rule
 * Custom Attachment Location's collector applies, deliberately: a unit that two plugins relocate must
 * land in the same place either way.
 *
 * @param params - The answer to plan from, and the folder being deleted.
 * @returns The move to perform, or `null` when the attachment travels alone.
 */
export function planUnitFolderMove(params: PlanUnitFolderMoveParams): null | UnitFolderMove {
  const oldFolderPath = params.rescueDestination.unitFolderPath;
  if (oldFolderPath === null) {
    return null;
  }

  /*
   * STRICTLY inside: a unit folder that IS the folder being deleted — or that contains it — must not be
   * moved, or the deletion the user asked for would silently become a move of something larger than what
   * they named. Such an attachment falls back to the lone-file rescue, which is what it got before unit
   * folders were honored at all.
   */
  if (!isStrictlyInside(oldFolderPath, params.rootFolderPath)) {
    return null;
  }

  const newFolderPath = join(dirname(params.rescueDestination.attachmentPath), basename(oldFolderPath));
  if (newFolderPath === oldFolderPath) {
    return null;
  }

  return {
    newFolderPath,
    oldFolderPath
  };
}

/**
 * Checks whether a path sits below an ancestor folder, and is not that folder itself.
 *
 * @param path - The path to test.
 * @param ancestorFolderPath - The folder it must sit below. The vault root — `/` or the empty string —
 * contains everything.
 * @returns `true` when the path is strictly inside the ancestor.
 */
function isStrictlyInside(path: string, ancestorFolderPath: string): boolean {
  const prefix = ancestorFolderPath === '' || ancestorFolderPath === '/' ? '' : `${ancestorFolderPath}/`;
  return path !== ancestorFolderPath && path.startsWith(prefix);
}
