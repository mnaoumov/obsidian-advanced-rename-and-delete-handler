/**
 * A string in a settings file that still names a path a batch of renames moved.
 */
export interface RenamedPathHit {
  /**
   * Where the value sits in the file, as `key.child[2]`, or `''` for a file holding a bare string.
   */
  readonly keyPath: string;

  /**
   * The path the value would name now, carrying the same trailing part under the moved path.
   */
  readonly newPath: string;

  /**
   * The value as it stands.
   */
  readonly value: string;
}

/**
 * Finds every string in a parsed settings file that names a path the batch moved, or a path under one.
 *
 * A setting can hold a path with or without a leading or trailing `/`, so both are stripped before comparing. A
 * match is exact and case-sensitive, and a path matches only at a segment boundary: `Notes` matches `Notes` and
 * `Notes/Daily`, never `Notes old`. Where several moved paths match one value, the longest wins, since a folder
 * and the files under it all arrive in one batch.
 *
 * @param data - The parsed JSON.
 * @param renames - The batch, old path to new path.
 * @returns The hits, in the order the walk meets them.
 */
export function findRenamedPaths(data: unknown, renames: ReadonlyMap<string, string>): RenamedPathHit[] {
  const moves = [...renames].filter(([oldPath, newPath]) => oldPath !== '' && oldPath !== newPath).sort(([a], [b]) => b.length - a.length);
  const hits: RenamedPathHit[] = [];
  walk(data, '', (value, keyPath) => {
    const normalizedValue = value.replaceAll(/^\/+|\/+$/g, '');
    const move = moves.find(([oldPath]) => normalizedValue === oldPath || normalizedValue.startsWith(`${oldPath}/`));
    if (move === undefined) {
      return;
    }

    hits.push({
      keyPath,
      newPath: move[1] + normalizedValue.slice(move[0].length),
      value
    });
  });
  return hits;
}

function walk(data: unknown, keyPath: string, visitString: (value: string, keyPath: string) => void): void {
  if (typeof data === 'string') {
    visitString(data, keyPath);
    return;
  }

  if (Array.isArray(data)) {
    for (const [index, item] of data.entries()) {
      walk(item, `${keyPath}[${String(index)}]`, visitString);
    }
    return;
  }

  if (typeof data === 'object' && data !== null) {
    for (const [key, value] of Object.entries(data)) {
      walk(value, keyPath === '' ? key : `${keyPath}.${key}`, visitString);
    }
  }
}
