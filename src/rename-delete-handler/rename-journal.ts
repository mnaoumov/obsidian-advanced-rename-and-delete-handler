/**
 * @file
 *
 * Lets a queued rename job find a note that was renamed after the job captured it.
 *
 * The rename handler captures, inside the vault `rename` event, which notes link to the renamed file. The
 * job that rewrites those links runs later, from a serial queue. A note that is itself renamed in between,
 * while the job waits for its turn or while it is half done, is no longer at the path the job captured,
 * and the rewrite skips a path that holds no file without a word. In a mass rename of 2,839 notes, three
 * links in one note were lost that way: their targets were renamed shortly before the note itself.
 *
 * So every rename is written down while some job still holds a {@link RenameJournalCursor}, and a cursor
 * follows a path through the renames recorded after it, in the order they happened. Following them in
 * order, from the cursor's own point, rather than through a map of the latest move per path, keeps a path
 * that was freed and then taken by another file pointing at the file the job meant.
 */

/**
 * A point in the journal, held by one queued job. Dispose of it when the job ends, or the journal keeps
 * every rename from that point on.
 */
export interface RenameJournalCursor {
  /**
   * Moves the cursor to now, so later calls follow only the renames recorded from here on. Call it once the
   * paths the job holds have been brought up to date.
   */
  readonly advance: () => void;

  /**
   * Releases the cursor, so the journal can drop the renames only it still needed. Calling it again does nothing.
   */
  readonly dispose: () => void;

  /**
   * Follows a path through the renames recorded since the cursor was taken or last advanced.
   *
   * @param path - A path a file had at the cursor's point.
   * @returns The path that file has now.
   */
  readonly resolve: (path: string) => string;

  /**
   * Re-keys a map by where each key's file is now. Two keys that now name one file are merged.
   *
   * @param map - A map keyed by paths files had at the cursor's point.
   * @param merge - Merges the value of a key into the value already held under the same current path.
   * @returns A new map, keyed by current paths.
   */
  readonly resolveKeys: <T>(map: ReadonlyMap<string, T>, merge: (this: void, existing: T, added: T) => void) => Map<string, T>;

  /**
   * Follows a path no file holds, such as the path a renamed note left, through the renames of the folders above
   * it recorded since the cursor was taken or last advanced. A rename of the path itself is not followed: the
   * file that left it is not the file that moves out of it later.
   *
   * @param path - A vacated path at the cursor's point.
   * @returns Where that path would be now.
   */
  readonly resolveVacatedPath: (path: string) => string;
}

interface JournalEntry {
  readonly newPath: string;
  readonly oldPath: string;
  readonly sequence: number;
}

/**
 * The renames made while a queued rename job could still be holding a path from before them.
 */
export class RenameJournal {
  /**
   * How many renames are held. Exposed for tests.
   *
   * @returns The number of held renames.
   */
  public get size(): number {
    return this.entries.length;
  }

  private readonly entries: JournalEntry[] = [];
  private lastSequence = 0;

  /**
   * The point each open cursor is at, keyed by an identity of its own.
   */
  private readonly openCursorSequences = new Map<object, number>();

  /**
   * Takes a cursor at the current point. Renames recorded from now on are followed by it.
   *
   * @returns The cursor.
   */
  public openCursor(): RenameJournalCursor {
    const identity = {};
    let sequence = this.lastSequence;
    let isDisposed = false;
    this.openCursorSequences.set(identity, sequence);
    return {
      advance: (): void => {
        if (isDisposed) {
          return;
        }
        sequence = this.lastSequence;
        this.openCursorSequences.set(identity, sequence);
        this.prune();
      },
      dispose: (): void => {
        if (isDisposed) {
          return;
        }
        isDisposed = true;
        this.openCursorSequences.delete(identity);
        this.prune();
      },
      resolve: (path: string): string => this.resolveFrom(path, sequence),
      resolveKeys: <T>(map: ReadonlyMap<string, T>, merge: (existing: T, added: T) => void): Map<string, T> => {
        const resolved = new Map<string, T>();
        for (const [path, value] of map) {
          const currentPath = this.resolveFrom(path, sequence);
          const existing = resolved.get(currentPath);
          if (existing === undefined) {
            resolved.set(currentPath, value);
          } else {
            merge(existing, value);
          }
        }
        return resolved;
      },
      resolveVacatedPath: (path: string): string => this.resolveVacatedPathFrom(path, sequence)
    };
  }

  /**
   * Writes a rename down, if some job still holds a cursor that could need it.
   *
   * @param oldPath - The path the file had.
   * @param newPath - The path it has now.
   */
  public record(oldPath: string, newPath: string): void {
    if (this.openCursorSequences.size === 0 || oldPath === newPath) {
      return;
    }
    this.lastSequence++;
    this.entries.push({ newPath, oldPath, sequence: this.lastSequence });
  }

  private prune(): void {
    if (this.openCursorSequences.size === 0) {
      this.entries.length = 0;
      return;
    }
    const oldestSequence = Math.min(...this.openCursorSequences.values());
    const firstKeptIndex = this.entries.findIndex((entry) => entry.sequence > oldestSequence);
    this.entries.splice(0, firstKeptIndex === -1 ? this.entries.length : firstKeptIndex);
  }

  private resolveFrom(path: string, sequence: number): string {
    let current = path;
    for (const entry of this.entries) {
      if (entry.sequence > sequence && entry.oldPath === current) {
        current = entry.newPath;
      }
    }
    return current;
  }

  private resolveVacatedPathFrom(path: string, sequence: number): string {
    let current = path;
    for (const entry of this.entries) {
      if (entry.sequence > sequence && current.startsWith(`${entry.oldPath}/`)) {
        current = entry.newPath + current.slice(entry.oldPath.length);
      }
    }
    return current;
  }
}

/**
 * Copies into `existing` every entry of `added` whose key it does not hold yet. The entry already held wins.
 *
 * @param existing - The map to merge into.
 * @param added - The map to merge from.
 */
export function mergeMissingEntries<K, V>(existing: Map<K, V>, added: ReadonlyMap<K, V>): void {
  for (const [key, value] of added) {
    if (!existing.has(key)) {
      existing.set(key, value);
    }
  }
}
