/**
 * @file
 *
 * This test file exists solely to import modules that are excluded from coverage via `v8 ignore`
 * comments. Without importing them, v8 never loads the files and the ignore comments are not processed,
 * causing them to appear as 0% covered.
 */

import {
  expect,
  it
} from 'vitest';

// eslint-disable-next-line import-x/no-namespace -- Namespace import needed to force v8 to load the module for coverage.
import * as RenameDeleteHandlerComponent from './rename-delete-handler-component.ts';

it('should load the modules excluded from coverage', () => {
  expect(RenameDeleteHandlerComponent).toBeDefined();
});
