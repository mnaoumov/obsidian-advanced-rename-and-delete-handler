import dedent from 'dedent';
import {
  describe,
  expect,
  it
} from 'vitest';

import {
  findHtmlPathReferences,
  splitHtmlPath
} from './html-path-references.ts';

function findValues(content: string): string[] {
  return findHtmlPathReferences(content).map((reference) => reference.rawValue);
}

describe('findHtmlPathReferences', () => {
  it('should find src and href values in every quoting style, with offsets that slice back to the value', () => {
    const content = '<img src="a b.png"> <a href=\'c.md\'>c</a> <video src=d.mp4 />';
    const references = findHtmlPathReferences(content);

    expect(references.map((reference) => ({
      isQuoted: reference.isQuoted,
      slice: content.slice(reference.valueStartOffset, reference.valueEndOffset),
      value: reference.rawValue
    }))).toEqual([
      { isQuoted: true, slice: 'a b.png', value: 'a b.png' },
      { isQuoted: true, slice: 'c.md', value: 'c.md' },
      { isQuoted: false, slice: 'd.mp4', value: 'd.mp4' }
    ]);
  });

  it('should find several path attributes on one tag, case-insensitively', () => {
    expect(findValues('<IMG alt="x" SRC = "a.png" data-x="y" href="b.png">')).toEqual(['a.png', 'b.png']);
  });

  it('should skip values that cannot name a vault file', () => {
    expect(findValues('<a href="#top"></a><a href=""></a><img src="//host/x.png"><img src="https://x/y.png"><img src="data:image/png;base64,AA">')).toEqual([]);
  });

  it('should skip tags without attributes and attributes that are not paths', () => {
    expect(findValues('<br> <div class="x.png"></div> <p/>')).toEqual([]);
  });

  it('should skip frontmatter, fenced code, inline code and comments', () => {
    const content = dedent`
      ---
      cover: <img src="front.png">
      ---
      \`\`\`html
      <img src="fenced.png">
      \`\`\`
      ~~~~
      <img src="tilde.png">
      ~~~~
      \`<img src="inline.png">\` and \`\`<img src="double.png">\`\`
      <!-- <img src="html-comment.png"> -->
      %% <img src="obsidian-comment.png"> %%
      <img src="kept.png">
    `;

    expect(findValues(content)).toEqual(['kept.png']);
  });

  it('should not close a fence on a shorter or different fence, nor on an over-indented one', () => {
    const content = dedent`
      \`\`\`\`
      \`\`\`
      ~~~~
          \`\`\`\`
      <img src="still-code.png">
      \`\`\`\`
      <img src="kept.png">
    `;

    expect(findValues(content)).toEqual(['kept.png']);
  });

  it('should treat an unclosed fence as code to the end of the note', () => {
    expect(findValues('<img src="before.png">\n```\n<img src="after.png">\n')).toEqual(['before.png']);
  });

  it('should not take a code span inside a fence for its own range', () => {
    expect(findValues('```\n`x\n```\n<img src="a.png"> `y`')).toEqual(['a.png']);
  });

  it('should read CRLF line endings', () => {
    expect(findValues('---\r\nx: 1\r\n---\r\n```\r\n<img src="code.png">\r\n```\r\n<img src="kept.png">')).toEqual(['kept.png']);
  });

  it('should take a note that is only frontmatter as all frontmatter', () => {
    expect(findValues('---\n<img src="front.png">\n---')).toEqual([]);
  });
});

describe('splitHtmlPath', () => {
  it('should decode a percent-encoded path and keep the query and fragment as written', () => {
    expect(splitHtmlPath('a%20b.png?w=1#x%20y')).toEqual({
      decodedPath: 'a b.png',
      isEncoded: true,
      suffix: '?w=1#x%20y'
    });
  });

  it('should leave a plain path as it is', () => {
    expect(splitHtmlPath('a b.png')).toEqual({
      decodedPath: 'a b.png',
      isEncoded: false,
      suffix: ''
    });
  });

  it('should take invalid percent-encoding as written', () => {
    expect(splitHtmlPath('100%.png')).toEqual({
      decodedPath: '100%.png',
      isEncoded: false,
      suffix: ''
    });
  });
});
