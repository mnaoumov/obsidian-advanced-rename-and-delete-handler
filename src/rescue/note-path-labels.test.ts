import {
  describe,
  expect,
  it
} from 'vitest';

import { getDisambiguatedNoteLabels } from './note-path-labels.ts';

function labelsOf(notePaths: readonly string[]): string[] {
  return getDisambiguatedNoteLabels(notePaths).map((entry) => entry.label);
}

describe('getDisambiguatedNoteLabels', () => {
  it('should keep the bare basename while it is unique', () => {
    expect(labelsOf(['Notes/a.md', 'Archive/2024/b.md'])).toEqual(['a.md', 'b.md']);
  });

  it('should pair every label with the path it stands for, in the given order', () => {
    expect(getDisambiguatedNoteLabels(['Notes/a.md', 'Archive/b.md'])).toEqual([
      {
        label: 'a.md',
        notePath: 'Notes/a.md'
      },
      {
        label: 'b.md',
        notePath: 'Archive/b.md'
      }
    ]);
  });

  it('should grow only the labels that collide, and only by the folder that tells them apart', () => {
    expect(labelsOf(['Archive/note.md', 'Notes/note.md', 'Notes/other.md'])).toEqual([
      'Archive/note.md',
      'Notes/note.md',
      'other.md'
    ]);
  });

  it('should elide the path above the segments it had to show', () => {
    expect(labelsOf(['Work/Archive/note.md', 'Personal/Notes/note.md'])).toEqual([
      '…/Archive/note.md',
      '…/Notes/note.md'
    ]);
  });

  it('should keep growing until the shared folders run out', () => {
    expect(labelsOf(['Work/Projects/Archive/note.md', 'Home/Projects/Archive/note.md'])).toEqual([
      'Work/Projects/Archive/note.md',
      'Home/Projects/Archive/note.md'
    ]);
  });

  it('should tell a root-level note from a nested one of the same name', () => {
    expect(labelsOf(['note.md', 'Notes/note.md'])).toEqual(['note.md', 'Notes/note.md']);
  });

  it('should stop growing against a rival too shallow to reach the suffix', () => {
    expect(labelsOf(['note.md', 'Archive/2024/note.md'])).toEqual(['note.md', '…/2024/note.md']);
  });

  it('should grow a colliding label only against the notes it actually collides with', () => {
    expect(labelsOf(['A/Deep/Tree/note.md', 'B/note.md', 'C/Deep/Tree/other.md'])).toEqual([
      '…/Tree/note.md',
      'B/note.md',
      'other.md'
    ]);
  });

  it('should show the full path for one note listed twice, rather than an elision it cannot back up', () => {
    expect(labelsOf(['Notes/note.md', 'Notes/note.md'])).toEqual(['Notes/note.md', 'Notes/note.md']);
  });

  it('should label nothing when there is nothing to label', () => {
    expect(getDisambiguatedNoteLabels([])).toEqual([]);
  });
});
