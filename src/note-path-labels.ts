/**
 * @file
 *
 * Names a set of notes on screen so that no two of them read the same.
 *
 * A basename is what a user recognizes a note by, and in most vaults it is already unique among the few
 * notes any one dialog offers. It is only when two of them share a name that the label has to say more,
 * and then only as much more as it takes: the folder above, or the two above that, rather than the whole
 * path every note in a deep vault would otherwise have to carry.
 *
 * So the rule is per-note, not per-dialog: a note whose basename is unique among the ones shown keeps the
 * bare basename, and one whose basename collides grows the shortest trailing run of path segments that
 * tells it apart from the notes it collided with. A grown label opens with an ellipsis, which is what
 * says the path continues above it.
 *
 * Two entries naming the SAME path are not a collision to resolve — they are one note listed twice, and
 * no suffix can tell them apart — so they end up on the full path and read identically, which is true.
 */

import { basename } from 'obsidian-dev-utils/path';

// The shortest grown label is the basename plus the folder above it: a one-segment suffix IS the basename that collided.
const MIN_DISTINGUISHING_SEGMENT_COUNT = 2;

/**
 * A note path and the label to show for it.
 */
export interface DisambiguatedNoteLabel {
  /**
   * What to show: the bare basename, or as much of the path as it took to tell this note from the rest.
   */
  readonly label: string;

  /**
   * The note path the label stands for, unchanged.
   */
  readonly notePath: string;
}

/**
 * Labels notes so that no two of the given paths read the same.
 *
 * The label is paired with its path rather than returned on its own, so a caller wiring labels to
 * actions cannot pair them up wrongly.
 *
 * @param notePaths - The note paths to label.
 * @returns One label per path, in the same order.
 */
export function getDisambiguatedNoteLabels(notePaths: readonly string[]): DisambiguatedNoteLabel[] {
  const seenBasenames = new Set<string>();
  const collidingBasenames = new Set<string>();

  for (const notePath of notePaths) {
    const name = basename(notePath);

    if (seenBasenames.has(name)) {
      collidingBasenames.add(name);
    } else {
      seenBasenames.add(name);
    }
  }

  return notePaths.map((notePath, index) => {
    const name = basename(notePath);

    if (!collidingBasenames.has(name)) {
      return {
        label: name,
        notePath
      };
    }

    /*
     * By index rather than by value: a path listed twice is its own rival, so nothing distinguishes it
     * and it falls through to the full path instead of claiming an elided one it does not have.
     */
    const rivalPaths = notePaths.filter((otherPath, otherIndex) => otherIndex !== index && basename(otherPath) === name);
    return {
      label: getShortestDistinguishingSuffix(notePath, rivalPaths),
      notePath
    };
  });
}

function checkEndsWithSegments(pathSegments: readonly string[], suffixSegments: readonly string[]): boolean {
  if (pathSegments.length < suffixSegments.length) {
    return false;
  }

  const offset = pathSegments.length - suffixSegments.length;
  return suffixSegments.every((segment, index) => pathSegments[offset + index] === segment);
}

function getShortestDistinguishingSuffix(notePath: string, rivalPaths: readonly string[]): string {
  const segments = notePath.split('/');
  const rivalSegments = rivalPaths.map((rivalPath) => rivalPath.split('/'));

  for (let segmentCount = MIN_DISTINGUISHING_SEGMENT_COUNT; segmentCount < segments.length; segmentCount++) {
    const suffixSegments = segments.slice(-segmentCount);

    if (rivalSegments.every((rival) => !checkEndsWithSegments(rival, suffixSegments))) {
      return `…/${suffixSegments.join('/')}`;
    }
  }

  return notePath;
}
