import type { Vault } from 'obsidian';

import {
  describe,
  expect,
  it
} from 'vitest';

import type { AttachmentUnitFolderDesignation } from './attachment-unit-folder-designation.ts';

import { checkIsAttachmentUnitFolder } from './attachment-unit-folder-designation.ts';

function createVault(designation?: AttachmentUnitFolderDesignation['checkIsAttachmentUnitFolder']): Vault {
  const vault = {} as Vault;
  Reflect.set(
    vault,
    'getAvailablePathForAttachments',
    Object.assign((): string => '', designation ? { checkIsAttachmentUnitFolder: designation } : {})
  );
  return vault;
}

describe('checkIsAttachmentUnitFolder', () => {
  it('should answer with the designation an attachment-location plugin published', () => {
    const vault = createVault((folderPath) => folderPath === 'Notes/drawing_files');

    expect(checkIsAttachmentUnitFolder({ folderPath: 'Notes/drawing_files', vault })).toBe(true);
    expect(checkIsAttachmentUnitFolder({ folderPath: 'Notes', vault })).toBe(false);
  });

  it('should answer false when no plugin published a designation', () => {
    expect(checkIsAttachmentUnitFolder({ folderPath: 'Notes/drawing_files', vault: createVault() })).toBe(false);
  });

  it('should answer false when the vault carries no patched function at all', () => {
    expect(checkIsAttachmentUnitFolder({ folderPath: 'Notes/drawing_files', vault: {} as Vault })).toBe(false);
  });
});
