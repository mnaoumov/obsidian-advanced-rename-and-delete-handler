import {
  describe,
  expect,
  it
} from 'vitest';

import { planUnitFolderMove } from './unit-folder-rescue.ts';

const RESCUED_ATTACHMENT_PATH = 'Keeper/assets/image.png';

describe('planUnitFolderMove', () => {
  it('should plan no move when the attachment travels alone', () => {
    expect(planUnitFolderMove({
      rescueDestination: { attachmentPath: RESCUED_ATTACHMENT_PATH, unitFolderPath: null },
      rootFolderPath: 'Deleted'
    })).toBeNull();
  });

  it('should land the unit folder under its own name inside the destination attachment folder', () => {
    expect(planUnitFolderMove({
      rescueDestination: { attachmentPath: RESCUED_ATTACHMENT_PATH, unitFolderPath: 'Deleted/assets/drawing_files' },
      rootFolderPath: 'Deleted'
    })).toEqual({
      newFolderPath: 'Keeper/assets/drawing_files',
      oldFolderPath: 'Deleted/assets/drawing_files'
    });
  });

  it('should plan no move when the unit folder IS the folder being deleted', () => {
    expect(planUnitFolderMove({
      rescueDestination: { attachmentPath: RESCUED_ATTACHMENT_PATH, unitFolderPath: 'Deleted' },
      rootFolderPath: 'Deleted'
    })).toBeNull();
  });

  it('should plan no move when the unit folder contains the folder being deleted', () => {
    expect(planUnitFolderMove({
      rescueDestination: { attachmentPath: RESCUED_ATTACHMENT_PATH, unitFolderPath: 'Deleted' },
      rootFolderPath: 'Deleted/assets'
    })).toBeNull();
  });

  /*
   * The second look at a unit folder this deletion already moved. The resolver answers with the adopting
   * note's attachment folder plus the file's own name, so a folder that already sits there plans itself
   * back onto its own path — which is what makes the hook safe to ask twice.
   */
  it('should plan no move when the unit folder is already at its destination', () => {
    expect(planUnitFolderMove({
      rescueDestination: { attachmentPath: RESCUED_ATTACHMENT_PATH, unitFolderPath: 'Keeper/assets/drawing_files' },
      rootFolderPath: ''
    })).toBeNull();
  });

  it('should treat the vault root as containing every unit folder', () => {
    expect(planUnitFolderMove({
      rescueDestination: { attachmentPath: RESCUED_ATTACHMENT_PATH, unitFolderPath: 'drawing_files' },
      rootFolderPath: '/'
    })).toEqual({
      newFolderPath: 'Keeper/assets/drawing_files',
      oldFolderPath: 'drawing_files'
    });
  });
});
