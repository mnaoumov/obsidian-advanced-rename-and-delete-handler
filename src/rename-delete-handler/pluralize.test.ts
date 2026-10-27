import {
  describe,
  expect,
  it
} from 'vitest';

import { pluralize } from './pluralize.ts';

describe('pluralize', () => {
  it('should leave a count of one singular', () => {
    expect(pluralize(1, 'link')).toBe('1 link');
  });

  it('should pluralize every other count', () => {
    expect(pluralize(0, 'link')).toBe('0 links');
    expect(pluralize(2, 'file')).toBe('2 files');
  });

  it('should group a large count the way the locale does', () => {
    expect(pluralize(1234, 'file')).toBe(`${(1234).toLocaleString()} files`);
  });
});
