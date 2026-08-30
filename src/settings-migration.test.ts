import { castTo } from 'obsidian-dev-utils/object-utils';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { MigratableSettingPropertyName } from './settings-migration.ts';

import { PluginSettings } from './plugin-settings.ts';
import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';
import {
  applyMigratableSettings,
  applyMigrationRows,
  buildSettingsMigrationRows,
  formatMigratableSettingValue,
  formatStringListForEditing,
  getEmptyFolderBehaviorLabel,
  MIGRATABLE_SETTING_DESCRIPTORS,
  MigratableSettingKind,
  parseStringList,
  readMigratableSetting,
  toEmptyFolderBehaviorOrNull
} from './settings-migration.ts';

describe('MIGRATABLE_SETTING_DESCRIPTORS', () => {
  it('should describe every setting a consumer may propose, in the settings tab\'s own order', () => {
    expect(MIGRATABLE_SETTING_DESCRIPTORS.map((descriptor) => descriptor.propertyName)).toEqual([
      'shouldHandleRenames',
      'shouldUpdateFileNameAliases',
      'shouldRenameAttachmentFolder',
      'shouldRenameAttachmentFiles',
      'shouldDeleteConflictingAttachments',
      'shouldHandleDeletions',
      'emptyFolderBehavior',
      'shouldRescueSharedAttachments',
      'notePriorities',
      'treatAsAttachmentExtensions',
      'includePaths',
      'excludePaths'
    ]);
  });

  it('should name each setting the way the settings tab names it', () => {
    const descriptor = MIGRATABLE_SETTING_DESCRIPTORS.find((candidate) => candidate.propertyName === 'shouldHandleRenames');
    expect(descriptor?.name).toBe('Should handle renames');
    expect(descriptor?.kind).toBe(MigratableSettingKind.Boolean);
  });

  it('should read every described setting off a real settings object', () => {
    const settings = new PluginSettings();
    for (const descriptor of MIGRATABLE_SETTING_DESCRIPTORS) {
      expect(readMigratableSetting(settings, descriptor.propertyName)).toBeDefined();
    }
  });
});

describe('buildSettingsMigrationRows', () => {
  it('should list only the settings the proposal names', () => {
    const rows = buildSettingsMigrationRows({
      currentSettings: new PluginSettings(),
      proposedSettings: { shouldHandleDeletions: true }
    });

    expect(rows.map((row) => row.descriptor.propertyName)).toEqual(['shouldHandleDeletions']);
    expect(rows[0]?.currentValue).toBe(false);
    expect(rows[0]?.proposedValue).toBe(true);
  });

  it('should drop a proposal that matches what the plugin already holds', () => {
    const rows = buildSettingsMigrationRows({
      currentSettings: new PluginSettings(),
      proposedSettings: {
        shouldHandleDeletions: true,
        shouldHandleRenames: true,
        treatAsAttachmentExtensions: ['.excalidraw.md']
      }
    });

    expect(rows.map((row) => row.descriptor.propertyName)).toEqual(['shouldHandleDeletions']);
  });

  it('should keep the settings tab\'s order regardless of the proposal\'s key order', () => {
    const rows = buildSettingsMigrationRows({
      currentSettings: new PluginSettings(),
      proposedSettings: {
        emptyFolderBehavior: EmptyFolderBehavior.Delete,
        excludePaths: ['Archive'],
        shouldHandleDeletions: true
      }
    });

    expect(rows.map((row) => row.descriptor.propertyName)).toEqual([
      'shouldHandleDeletions',
      'emptyFolderBehavior',
      'excludePaths'
    ]);
  });
});

describe('applyMigratableSettings', () => {
  it('should write every kind of value onto the settings object', () => {
    const settings = new PluginSettings();

    applyMigratableSettings(settings, {
      emptyFolderBehavior: EmptyFolderBehavior.DeleteWithEmptyParents,
      excludePaths: ['Archive'],
      shouldHandleDeletions: true
    });

    expect(settings.emptyFolderBehavior).toBe(EmptyFolderBehavior.DeleteWithEmptyParents);
    expect(settings.excludePaths).toEqual(['Archive']);
    expect(settings.shouldHandleDeletions).toBe(true);
  });

  it('should leave a setting the proposal does not name alone', () => {
    const settings = new PluginSettings();

    applyMigratableSettings(settings, { shouldHandleDeletions: true });

    expect(settings.shouldHandleRenames).toBe(true);
    expect(settings.notePriorities).toEqual([]);
  });

  it('should refuse a value of the wrong type rather than corrupting the settings', () => {
    const settings = new PluginSettings();

    expect(() => {
      applyMigratableSettings(settings, { shouldHandleDeletions: castTo<boolean>('yes') });
    }).toThrow('Setting "shouldHandleDeletions" expects a boolean');
  });
});

describe('applyMigrationRows', () => {
  it('writes the value each row carries, which is what the user left in the dialog', () => {
    const settings = new PluginSettings();

    applyMigrationRows(settings, [
      {
        currentValue: false,
        descriptor: {
          kind: MigratableSettingKind.Boolean,
          name: 'Should handle deletions',
          propertyName: 'shouldHandleDeletions'
        },
        proposedValue: true
      }
    ]);

    expect(settings.shouldHandleDeletions).toBe(true);
  });
});

describe('applyMigratableSettings, over every setting a consumer may propose', () => {
  it('writes every one of them', () => {
    const settings = new PluginSettings();

    applyMigratableSettings(settings, {
      emptyFolderBehavior: EmptyFolderBehavior.Delete,
      excludePaths: ['Archive'],
      includePaths: ['Notes'],
      notePriorities: ['.md'],
      shouldDeleteConflictingAttachments: true,
      shouldHandleDeletions: true,
      shouldHandleRenames: false,
      shouldRenameAttachmentFiles: true,
      shouldRenameAttachmentFolder: false,
      shouldRescueSharedAttachments: true,
      shouldUpdateFileNameAliases: false,
      treatAsAttachmentExtensions: ['.canvas']
    });

    for (const descriptor of MIGRATABLE_SETTING_DESCRIPTORS) {
      expect(readMigratableSetting(settings, descriptor.propertyName)).toBeDefined();
    }

    expect(settings.emptyFolderBehavior).toBe(EmptyFolderBehavior.Delete);
    expect(settings.excludePaths).toEqual(['Archive']);
    expect(settings.includePaths).toEqual(['Notes']);
    expect(settings.notePriorities).toEqual(['.md']);
    expect(settings.shouldDeleteConflictingAttachments).toBe(true);
    expect(settings.shouldHandleRenames).toBe(false);
    expect(settings.shouldRenameAttachmentFiles).toBe(true);
    expect(settings.shouldRenameAttachmentFolder).toBe(false);
    expect(settings.shouldRescueSharedAttachments).toBe(true);
    expect(settings.shouldUpdateFileNameAliases).toBe(false);
    expect(settings.treatAsAttachmentExtensions).toEqual(['.canvas']);
  });

  it('refuses an empty folder behavior it does not know', () => {
    const settings = new PluginSettings();

    expect(() => {
      applyMigratableSettings(settings, { emptyFolderBehavior: castTo<EmptyFolderBehavior>('Incinerate') });
    }).toThrow('Setting "emptyFolderBehavior" expects an empty folder behavior');

    expect(() => {
      applyMigratableSettings(settings, { emptyFolderBehavior: castTo<EmptyFolderBehavior>(true) });
    }).toThrow('Setting "emptyFolderBehavior" expects an empty folder behavior');
  });

  it('refuses a list that is not a list of strings', () => {
    const settings = new PluginSettings();

    expect(() => {
      applyMigratableSettings(settings, { notePriorities: castTo<readonly string[]>('.md') });
    }).toThrow('Setting "notePriorities" expects a list of strings');

    expect(() => {
      applyMigratableSettings(settings, { notePriorities: castTo<readonly string[]>([1]) });
    }).toThrow('Setting "notePriorities" expects a list of strings');
  });
});

describe('formatMigratableSettingValue', () => {
  it('states a switch as enabled or disabled rather than as true or false', () => {
    expect(formatMigratableSettingValue(true)).toBe('Enabled');
    expect(formatMigratableSettingValue(false)).toBe('Disabled');
  });

  it('names an empty folder behavior the way the settings tab names it', () => {
    expect(formatMigratableSettingValue(EmptyFolderBehavior.DeleteWithEmptyParents)).toBe('Delete with empty parents');
  });

  it('states a list, and says so when it is empty', () => {
    expect(formatMigratableSettingValue(['.md', '.canvas'])).toBe('.md, .canvas');
    expect(formatMigratableSettingValue([])).toBe('(empty)');
  });
});

describe('formatStringListForEditing', () => {
  it('puts one entry on each line', () => {
    expect(formatStringListForEditing(['.md', '.canvas'])).toBe('.md\n.canvas');
  });

  it('states a non-list value as it is, which is what a dropdown reads back', () => {
    expect(formatStringListForEditing(EmptyFolderBehavior.Keep)).toBe('Keep');
    expect(formatStringListForEditing(true)).toBe('true');
  });
});

describe('getEmptyFolderBehaviorLabel', () => {
  it('names every member', () => {
    expect(getEmptyFolderBehaviorLabel(EmptyFolderBehavior.Keep)).toBe('Keep');
    expect(getEmptyFolderBehaviorLabel(EmptyFolderBehavior.Delete)).toBe('Delete');
    expect(getEmptyFolderBehaviorLabel(EmptyFolderBehavior.DeleteWithEmptyParents)).toBe('Delete with empty parents');
  });
});

describe('parseStringList', () => {
  it('trims each line and drops the blank ones', () => {
    expect(parseStringList('  .md  \n\n.canvas\n')).toEqual(['.md', '.canvas']);
  });

  it('reads an empty box as an empty list', () => {
    expect(parseStringList('')).toEqual([]);
  });
});

describe('toEmptyFolderBehaviorOrNull', () => {
  it('narrows a member name', () => {
    expect(toEmptyFolderBehaviorOrNull('Delete')).toBe(EmptyFolderBehavior.Delete);
  });

  it('answers null for anything else', () => {
    expect(toEmptyFolderBehaviorOrNull('Incinerate')).toBeNull();
  });
});

describe('the exhaustiveness guards', () => {
  it('refuse an empty folder behavior member that does not exist', () => {
    expect(() => getEmptyFolderBehaviorLabel(castTo<EmptyFolderBehavior>('Incinerate'))).toThrow();
  });

  it('refuse a setting name that is not one of the migratable ones', () => {
    expect(() => {
      applyMigrationRows(new PluginSettings(), [{
        currentValue: false,
        descriptor: {
          kind: MigratableSettingKind.Boolean,
          name: 'Something new',
          propertyName: castTo<MigratableSettingPropertyName>('shouldSomethingNew')
        },
        proposedValue: true
      }]);
    }).toThrow();
  });
});
