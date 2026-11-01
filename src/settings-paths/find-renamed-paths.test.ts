import {
  describe,
  expect,
  it
} from 'vitest';

import { findRenamedPaths } from './find-renamed-paths.ts';

const RENAMES = new Map([
  ['', 'Root'],
  ['Templates', 'Meta/Templates'],
  ['Templates/Daily.md', 'Meta/Templates/Daily.md'],
  ['Unchanged', 'Unchanged']
]);

describe('findRenamedPaths', () => {
  it('should find a moved path and a path under it anywhere in the data, naming where it sits', () => {
    expect(findRenamedPaths({
      folder: 'Templates',
      nested: { list: ['x', '/Templates/Weekly/'] },
      template: 'Templates/Daily.md'
    }, RENAMES)).toEqual([
      { keyPath: 'folder', newPath: 'Meta/Templates', value: 'Templates' },
      { keyPath: 'nested.list[1]', newPath: 'Meta/Templates/Weekly', value: '/Templates/Weekly/' },
      { keyPath: 'template', newPath: 'Meta/Templates/Daily.md', value: 'Templates/Daily.md' }
    ]);
  });

  it('should match only at a segment boundary, and only exactly', () => {
    expect(findRenamedPaths(['Templates old', 'templates', 'MyTemplates'], RENAMES)).toEqual([]);
  });

  it('should ignore a path the batch left where it was, and the vault root', () => {
    expect(findRenamedPaths(['Unchanged', 'Unchanged/x', ''], RENAMES)).toEqual([]);
  });

  it('should read a bare string, and pass over numbers, booleans and null', () => {
    expect(findRenamedPaths('Templates', RENAMES)).toEqual([{ keyPath: '', newPath: 'Meta/Templates', value: 'Templates' }]);
    expect(findRenamedPaths({ a: 1, b: true, c: null }, RENAMES)).toEqual([]);
  });
});
