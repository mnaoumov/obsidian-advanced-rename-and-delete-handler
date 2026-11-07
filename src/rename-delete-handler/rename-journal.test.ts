import {
  describe,
  expect,
  it
} from 'vitest';

import {
  mergeMissingEntries,
  RenameJournal
} from './rename-journal.ts';

describe('RenameJournal', () => {
  it('should hold nothing while no cursor is open', () => {
    const journal = new RenameJournal();
    journal.record('a.md', 'b.md');
    expect(journal.size).toBe(0);
  });

  it('should ignore a rename to the same path', () => {
    const journal = new RenameJournal();
    journal.openCursor();
    journal.record('a.md', 'a.md');
    expect(journal.size).toBe(0);
  });

  it('should follow a path through every rename recorded after the cursor, in order', () => {
    const journal = new RenameJournal();
    journal.record('before.md', 'ignored.md');
    const cursor = journal.openCursor();
    journal.record('a.md', 'b.md');
    journal.record('b.md', 'c.md');
    expect(cursor.resolve('a.md')).toBe('c.md');
    expect(cursor.resolve('before.md')).toBe('before.md');
  });

  it('should keep a freed path that another file took pointing at the file the cursor meant', () => {
    const journal = new RenameJournal();
    const cursor = journal.openCursor();
    journal.record('a.md', 'moved.md');
    journal.record('other.md', 'a.md');
    expect(cursor.resolve('a.md')).toBe('moved.md');
    expect(cursor.resolve('other.md')).toBe('a.md');
  });

  it('should not follow renames recorded before the cursor was taken', () => {
    const journal = new RenameJournal();
    journal.openCursor();
    journal.record('a.md', 'b.md');
    const newer = journal.openCursor();
    journal.record('b.md', 'c.md');
    expect(newer.resolve('a.md')).toBe('a.md');
    expect(newer.resolve('b.md')).toBe('c.md');
  });

  it('should follow only later renames after advance', () => {
    const journal = new RenameJournal();
    const cursor = journal.openCursor();
    journal.record('a.md', 'b.md');
    cursor.advance();
    expect(journal.size).toBe(0);
    expect(cursor.resolve('a.md')).toBe('a.md');
    journal.record('b.md', 'c.md');
    expect(cursor.resolve('b.md')).toBe('c.md');
  });

  it('should keep the renames an older cursor still needs and drop them once it is disposed', () => {
    const journal = new RenameJournal();
    const older = journal.openCursor();
    journal.record('a.md', 'b.md');
    const newer = journal.openCursor();
    journal.record('b.md', 'c.md');
    expect(journal.size).toBe(2);
    older.dispose();
    expect(journal.size).toBe(1);
    expect(newer.resolve('b.md')).toBe('c.md');
  });

  it('should count two cursors at the same point separately', () => {
    const journal = new RenameJournal();
    const first = journal.openCursor();
    const second = journal.openCursor();
    journal.record('a.md', 'b.md');
    first.dispose();
    expect(journal.size).toBe(1);
    expect(second.resolve('a.md')).toBe('b.md');
    second.dispose();
    expect(journal.size).toBe(0);
  });

  it('should make dispose idempotent and advance a no-op once disposed', () => {
    const journal = new RenameJournal();
    journal.openCursor();
    const cursor = journal.openCursor();
    journal.record('a.md', 'b.md');
    cursor.dispose();
    cursor.dispose();
    cursor.advance();
    expect(journal.size).toBe(1);
  });

  it('should follow a vacated path through later renames of the folders above it, and not through its own', () => {
    const journal = new RenameJournal();
    const cursor = journal.openCursor();
    journal.record('d/d-Index.md', 'd/other.md');
    journal.record('d', 'e');
    journal.record('e/_resources', 'e/res');
    journal.record('x', 'y');
    expect(cursor.resolveVacatedPath('d/d-Index.md')).toBe('e/d-Index.md');
    expect(cursor.resolveVacatedPath('d/_resources/d-Index')).toBe('e/res/d-Index');
    expect(cursor.resolveVacatedPath('dd/x.md')).toBe('dd/x.md');
    expect(cursor.resolve('d/gone.md')).toBe('d/gone.md');
  });

  it('should re-key a map by current paths and merge keys that now name one file', () => {
    const journal = new RenameJournal();
    const cursor = journal.openCursor();
    journal.record('a.md', 'c.md');
    const map = new Map<string, string[]>([
      ['a.md', ['from a']],
      ['b.md', ['from b']],
      ['c.md', ['from c']]
    ]);
    journal.record('c.md', 'd.md');
    const resolved = cursor.resolveKeys(map, (existing, added) => {
      existing.push(...added);
    });
    expect([...resolved]).toEqual([
      ['d.md', ['from a', 'from c']],
      ['b.md', ['from b']]
    ]);
  });
});

describe('mergeMissingEntries', () => {
  it('should add missing keys and keep the entries already held', () => {
    const existing = new Map([['a', 1]]);
    mergeMissingEntries(existing, new Map([['a', 2], ['b', 3]]));
    expect([...existing]).toEqual([['a', 1], ['b', 3]]);
  });
});
