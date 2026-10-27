/**
 * @file
 *
 * Formats a count with its noun.
 *
 * Its own module because the rename/delete handler it is used from is excluded from coverage wholesale
 * — "deeply coupled to Obsidian runtime" — and this is not: it is pure, and the string it builds is the
 * plugin's most visible piece of user-facing text.
 */

/**
 * Formats a count with its noun, singular or plural.
 *
 * @param count - How many.
 * @param noun - The singular noun.
 * @returns The formatted phrase, e.g. `1 link` or `2 links`.
 */
export function pluralize(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}
