import {
  describe,
  expect,
  it
} from 'vitest';

import type { HtmlPathRewriteContext } from './html-path-rewriter.ts';

import { rewriteHtmlPathReferences } from './html-path-rewriter.ts';

interface RewriteParams {
  /**
   * Every file in the vault AFTER the batch.
   */
  readonly filesNow: readonly string[];
  readonly newNotePath?: string;
  readonly oldNotePath?: string;
  readonly renames: Readonly<Record<string, string>>;
}

/**
 * Builds a context over a small vault, with a link resolver that matches Obsidian's on the shapes the tests use: a
 * full path, then a trailing run of segments, with a note's `.md` optional.
 *
 * @param params - The vault and the batch.
 * @returns The context.
 */
function createContext(params: RewriteParams): HtmlPathRewriteContext {
  const filesNow = new Set(params.filesNow);
  const notePath = params.newNotePath ?? 'notes/note.md';
  return {
    existsNow: (path) => filesNow.has(path),
    newNotePath: notePath,
    oldNotePath: params.oldNotePath ?? notePath,
    renames: new Map(Object.entries(params.renames)),
    resolveNow: (linkpath) => [...filesNow].find((path) => path === linkpath || path.endsWith(`/${linkpath}`) || path === `${linkpath}.md` || path.endsWith(`/${linkpath}.md`)) ?? null,
    shortestLinkpath: (targetPath, _sourcePath, shouldKeepMdExtension): string => {
      const name = targetPath.slice(targetPath.lastIndexOf('/') + 1);
      return shouldKeepMdExtension || !name.endsWith('.md') ? name : name.slice(0, -'.md'.length);
    }
  };
}

function rewrite(content: string, params: RewriteParams): string {
  return rewriteHtmlPathReferences(content, createContext(params)).content;
}

describe('rewriteHtmlPathReferences', () => {
  describe('when the target moved', () => {
    const params: RewriteParams = {
      filesNow: ['notes/note.md', 'assets/new name.png'],
      renames: { 'notes/old name.png': 'assets/new name.png' }
    };

    it('should keep a full path full, and encoded when it was', () => {
      expect(rewrite('<img src="notes/old%20name.png">', params)).toBe('<img src="assets/new%20name.png">');
    });

    it('should keep a rooted path rooted', () => {
      expect(rewrite('<img src="/notes/old name.png">', params)).toBe('<img src="/assets/new name.png">');
    });

    it('should keep a dot-relative path relative to the note', () => {
      expect(rewrite('<img src="./old name.png">', params)).toBe('<img src="../assets/new name.png">');
    });

    it('should keep a bare name the shortest link path', () => {
      expect(rewrite('<img src="old name.png">', params)).toBe('<img src="new name.png">');
    });

    it('should keep the query and fragment', () => {
      expect(rewrite('<img src="notes/old name.png?w=10#a">', params)).toBe('<img src="assets/new name.png?w=10#a">');
    });

    it('should quote an unquoted value that gains a space', () => {
      expect(rewrite('<img src=notes/old%20name.png> <img src=/notes/q.png> <img src=/notes/r.png>', {
        filesNow: ['notes/note.md', 'a b/x.png', 'q"/y.png', 'r/r.png'],
        renames: { 'notes/old name.png': 'a b/x.png', 'notes/q.png': 'q"/y.png', 'notes/r.png': 'r/r.png' }
      })).toBe('<img src=a%20b/x.png> <img src="/q&quot;/y.png"> <img src=/r/r.png>');
    });

    it('should report how many values it rewrote', () => {
      expect(rewriteHtmlPathReferences('<img src="notes/old name.png"><a href="./old name.png">x</a>', createContext(params)).rewrittenCount).toBe(2);
    });
  });

  describe('when the note moved', () => {
    const params: RewriteParams = {
      filesNow: ['archive/deep/note.md', 'notes/sub/x.png'],
      newNotePath: 'archive/deep/note.md',
      oldNotePath: 'notes/note.md',
      renames: { 'notes/note.md': 'archive/deep/note.md' }
    };

    it('should rewrite a dot-relative path against the new folder', () => {
      expect(rewrite('<img src="./sub/x.png">', params)).toBe('<img src="../../notes/sub/x.png">');
    });

    it('should leave a partial path the resolver still finds from the new folder', () => {
      expect(rewrite('<img src="sub/x.png">', params)).toBe('<img src="sub/x.png">');
    });

    it('should leave a value that still resolves', () => {
      expect(rewrite('<img src="x.png"> <img src="notes/sub/x.png">', params)).toBe('<img src="x.png"> <img src="notes/sub/x.png">');
    });
  });

  describe('when a folder-relative path breaks', () => {
    it('should rewrite it relative to the note folder', () => {
      expect(rewrite('<img src="sub/x.png">', {
        filesNow: ['notes/note.md', 'notes/other/x.png'],
        renames: { 'notes/sub/x.png': 'notes/other/x.png' }
      })).toBe('<img src="other/x.png">');
    });

    it('should keep a dot-relative path that now climbs as ../', () => {
      expect(rewrite('<img src="./x.png">', {
        filesNow: ['notes/note.md', 'x.png'],
        renames: { 'notes/x.png': 'x.png' }
      })).toBe('<img src="../x.png">');
    });

    it('should give a dot-relative path in the same folder its ./', () => {
      expect(rewrite('<img src="../x.png">', {
        filesNow: ['notes/note.md', 'notes/x.png'],
        renames: { 'x.png': 'notes/x.png' }
      })).toBe('<img src="./x.png">');
    });

    it('should resolve a relative path from a root note', () => {
      expect(rewrite('<img src="./a/x.png">', {
        filesNow: ['note.md', 'b/x.png'],
        newNotePath: 'note.md',
        renames: { 'a/x.png': 'b/x.png' }
      })).toBe('<img src="./b/x.png">');
    });
  });

  describe('when a partial path breaks', () => {
    it('should rewrite it to the shortest link path, keeping a note .md only when it had one', () => {
      expect(rewrite('<a href="deep/old.md">x</a> <a href="deep/old">y</a>', {
        filesNow: ['notes/note.md', 'elsewhere/new.md'],
        renames: { 'x/deep/old.md': 'elsewhere/new.md' }
      })).toBe('<a href="new.md">x</a> <a href="new">y</a>');
    });

    it('should prefer the moved file in the note folder when several match', () => {
      expect(rewrite('<img src="x.png">', {
        filesNow: ['notes/note.md', 'a/y.png', 'b/z.png'],
        renames: { 'notes/x.png': 'b/z.png', 'other/x.png': 'a/y.png' }
      })).toBe('<img src="z.png">');
    });

    it('should leave it when several match and none is in the note folder', () => {
      expect(rewrite('<img src="x.png">', {
        filesNow: ['notes/note.md', 'a/y.png', 'b/z.png'],
        renames: { 'one/x.png': 'b/z.png', 'two/x.png': 'a/y.png' }
      })).toBe('<img src="x.png">');
    });
  });

  describe('when nothing can be said', () => {
    it('should leave a value that named no file before the batch', () => {
      expect(rewrite('<img src="./missing.png"> <img src="/missing.png"> <img src="missing.png"> <img src="a/missing.png">', {
        filesNow: ['notes/note.md'],
        renames: { 'notes/x.png': 'y/x.png' }
      })).toBe('<img src="./missing.png"> <img src="/missing.png"> <img src="missing.png"> <img src="a/missing.png">');
    });

    it('should leave a value climbing above the vault root', () => {
      expect(rewrite('<img src="../../x.png">', {
        filesNow: ['notes/note.md', 'y.png'],
        renames: { 'x.png': 'y.png' }
      })).toBe('<img src="../../x.png">');
    });

    it('should leave a value whose file moved again and is gone', () => {
      expect(rewrite('<img src="notes/x.png">', {
        filesNow: ['notes/note.md'],
        renames: { 'notes/x.png': 'gone/x.png' }
      })).toBe('<img src="notes/x.png">');
    });

    it('should leave a value whose rewrite would read the same', () => {
      const context: HtmlPathRewriteContext = {
        ...createContext({
          filesNow: ['notes/note.md', 'b/x.png'],
          renames: { 'a/x.png': 'b/x.png' }
        }),
        // A resolver that has not caught up with the move, so the value reads as broken.
        resolveNow: () => null
      };

      expect(rewriteHtmlPathReferences('<img src="x.png">', context)).toEqual({ content: '<img src="x.png">', rewrittenCount: 0 });
    });
  });
});
