/**
 * @file
 *
 * The value half of a settings migration: what a consumer may propose, how a proposal compares against what
 * this plugin already holds, and how an approved proposal is written.
 *
 * Kept apart from the dialog so the comparison is testable without a modal, and apart from the API surface so
 * the contract stays a plain description of types.
 */

import type { ReadonlyPluginSettings } from 'obsidian-dev-utils/obsidian/components/plugin-settings-component';

import { isDeepEqual } from 'obsidian-dev-utils/object-utils';
import { assertNever } from 'obsidian-dev-utils/type-guards';

import type { MigratableSettings } from './plugin-api.ts';
import type { PluginSettings } from './plugin-settings.ts';

import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';

/**
 * How a proposed value is edited in the dialog, and what it is checked against before it is written.
 */
export enum MigratableSettingKind {
  /**
   * A switch — rendered as a toggle.
   */
  Boolean = 'Boolean',

  /**
   * One of {@link EmptyFolderBehavior}'s members — rendered as a dropdown.
   */
  EmptyFolder = 'EmptyFolder',

  /**
   * A list of lines — rendered as a multi-line text box, one entry per line.
   */
  StringList = 'StringList'
}

/**
 * Parameters for {@link buildSettingsMigrationRows}.
 */
export interface BuildSettingsMigrationRowsParams {
  /**
   * What this plugin holds right now.
   */
  readonly currentSettings: ReadonlyPluginSettings<PluginSettings>;

  /**
   * What the consumer proposes.
   */
  readonly proposedSettings: MigratableSettings;
}

/**
 * What the dialog needs to know about one migratable setting.
 */
export interface MigratableSettingDescriptor {
  /**
   * How the value is edited and validated.
   */
  readonly kind: MigratableSettingKind;

  /**
   * The setting's name, spelled exactly as the settings tab spells it, so the dialog and the tab name the
   * same thing the same way.
   */
  readonly name: string;

  /**
   * The property this setting lives on.
   */
  readonly propertyName: MigratableSettingPropertyName;
}

/**
 * The name of a setting a consumer may propose.
 */
export type MigratableSettingPropertyName =
  | 'emptyFolderBehavior'
  | 'excludePaths'
  | 'includePaths'
  | 'notePriorities'
  | 'shouldDeleteConflictingAttachments'
  | 'shouldHandleDeletions'
  | 'shouldHandleRenames'
  | 'shouldRenameAttachmentFiles'
  | 'shouldRenameAttachmentFolder'
  | 'shouldRescueSharedAttachments'
  | 'shouldUpdateFileNameAliases'
  | 'treatAsAttachmentExtensions';

/**
 * A value any migratable setting may hold.
 */
export type MigratableSettingValue = boolean | EmptyFolderBehavior | readonly string[];

/**
 * One line of the comparison dialog: what this plugin holds now, against what the consumer proposes.
 */
export interface SettingsMigrationRow {
  /**
   * What this plugin holds right now.
   */
  readonly currentValue: MigratableSettingValue;

  /**
   * The setting this row is about.
   */
  readonly descriptor: MigratableSettingDescriptor;

  /**
   * What the consumer proposes.
   */
  readonly proposedValue: MigratableSettingValue;
}

/**
 * Every setting a consumer may propose, in the order the settings tab lists them — renames, then deletions,
 * then scope. The dialog reads in the same order as the tab it is about to change.
 */
export const MIGRATABLE_SETTING_DESCRIPTORS: readonly MigratableSettingDescriptor[] = [
  {
    kind: MigratableSettingKind.Boolean,
    name: 'Should handle renames',
    propertyName: 'shouldHandleRenames'
  },
  {
    kind: MigratableSettingKind.Boolean,
    name: 'Should update file name aliases',
    propertyName: 'shouldUpdateFileNameAliases'
  },
  {
    kind: MigratableSettingKind.Boolean,
    name: 'Should rename attachment folder',
    propertyName: 'shouldRenameAttachmentFolder'
  },
  {
    kind: MigratableSettingKind.Boolean,
    name: 'Should rename attachment files',
    propertyName: 'shouldRenameAttachmentFiles'
  },
  {
    kind: MigratableSettingKind.Boolean,
    name: 'Should delete conflicting attachments',
    propertyName: 'shouldDeleteConflictingAttachments'
  },
  {
    kind: MigratableSettingKind.Boolean,
    name: 'Should handle deletions',
    propertyName: 'shouldHandleDeletions'
  },
  {
    kind: MigratableSettingKind.EmptyFolder,
    name: 'Empty folder behavior',
    propertyName: 'emptyFolderBehavior'
  },
  {
    kind: MigratableSettingKind.Boolean,
    name: 'Should rescue shared attachments',
    propertyName: 'shouldRescueSharedAttachments'
  },
  {
    kind: MigratableSettingKind.StringList,
    name: 'Note priorities',
    propertyName: 'notePriorities'
  },
  {
    kind: MigratableSettingKind.StringList,
    name: 'Treat as attachment extensions',
    propertyName: 'treatAsAttachmentExtensions'
  },
  {
    kind: MigratableSettingKind.StringList,
    name: 'Include paths',
    propertyName: 'includePaths'
  },
  {
    kind: MigratableSettingKind.StringList,
    name: 'Exclude paths',
    propertyName: 'excludePaths'
  }
];

const EMPTY_FOLDER_BEHAVIOR_BY_NAME = new Map<string, EmptyFolderBehavior>([
  [EmptyFolderBehavior.Delete, EmptyFolderBehavior.Delete],
  [EmptyFolderBehavior.DeleteWithEmptyParents, EmptyFolderBehavior.DeleteWithEmptyParents],
  [EmptyFolderBehavior.Keep, EmptyFolderBehavior.Keep]
]);

interface WriteMigratableSettingParams {
  readonly propertyName: MigratableSettingPropertyName;
  readonly settings: PluginSettings;
  readonly value: MigratableSettingValue;
}

/**
 * Writes an approved proposal onto the settings object.
 *
 * A value whose type does not match the setting throws rather than being written — the proposal crossed a
 * plugin boundary, so it is checked here rather than trusted.
 *
 * @param settings - The settings to write onto.
 * @param migratableSettings - The values to write.
 */
export function applyMigratableSettings(settings: PluginSettings, migratableSettings: MigratableSettings): void {
  for (const descriptor of MIGRATABLE_SETTING_DESCRIPTORS) {
    const value = migratableSettings[descriptor.propertyName];
    if (value === undefined) {
      continue;
    }

    writeMigratableSetting({
      propertyName: descriptor.propertyName,
      settings,
      value
    });
  }
}

/**
 * Writes the rows the user approved in the dialog, carrying whatever they edited the proposed values to.
 *
 * @param settings - The settings to write onto.
 * @param rows - The approved rows.
 */
export function applyMigrationRows(settings: PluginSettings, rows: readonly SettingsMigrationRow[]): void {
  for (const row of rows) {
    writeMigratableSetting({
      propertyName: row.descriptor.propertyName,
      settings,
      value: row.proposedValue
    });
  }
}

/**
 * Compares a proposal against what this plugin holds, and returns one row per setting that would actually
 * change. A proposal that matches the current value is not a change and is left out.
 *
 * @param params - The current settings and the proposal.
 * @returns The rows, in the settings tab's order.
 */
export function buildSettingsMigrationRows(params: BuildSettingsMigrationRowsParams): SettingsMigrationRow[] {
  const rows: SettingsMigrationRow[] = [];

  for (const descriptor of MIGRATABLE_SETTING_DESCRIPTORS) {
    const proposedValue = params.proposedSettings[descriptor.propertyName];
    if (proposedValue === undefined) {
      continue;
    }

    const currentValue = readMigratableSetting(params.currentSettings, descriptor.propertyName);
    if (isDeepEqual(currentValue, proposedValue)) {
      continue;
    }

    rows.push({
      currentValue,
      descriptor,
      proposedValue
    });
  }

  return rows;
}

/**
 * Renders a value the way the comparison dialog states it.
 *
 * @param value - The value to render.
 * @returns The text to show.
 */
export function formatMigratableSettingValue(value: MigratableSettingValue): string {
  if (typeof value === 'boolean') {
    return value ? 'Enabled' : 'Disabled';
  }

  if (typeof value === 'string') {
    return getEmptyFolderBehaviorLabel(value);
  }

  return value.length === 0 ? '(empty)' : value.join(', ');
}

/**
 * Renders a list value for the multi-line text box that edits it — one entry per line.
 *
 * @param value - The value to render.
 * @returns The text to edit.
 */
export function formatStringListForEditing(value: MigratableSettingValue): string {
  return typeof value === 'boolean' || typeof value === 'string' ? String(value) : value.join('\n');
}

/**
 * Names an {@link EmptyFolderBehavior} member the way the settings tab names it.
 *
 * @param emptyFolderBehavior - The member to name.
 * @returns The label.
 */
export function getEmptyFolderBehaviorLabel(emptyFolderBehavior: EmptyFolderBehavior): string {
  switch (emptyFolderBehavior) {
    case EmptyFolderBehavior.Delete: {
      return 'Delete';
    }
    case EmptyFolderBehavior.DeleteWithEmptyParents: {
      return 'Delete with empty parents';
    }
    case EmptyFolderBehavior.Keep: {
      return 'Keep';
    }
    default: {
      return assertNever(emptyFolderBehavior);
    }
  }
}

/**
 * Reads a multi-line text box back into a list. Blank lines are dropped and every entry is trimmed, so a
 * trailing newline does not become an empty entry.
 *
 * @param text - The text the user left in the box.
 * @returns The list.
 */
export function parseStringList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Reads one setting off the settings object.
 *
 * @param settings - The settings to read from.
 * @param propertyName - The setting to read.
 * @returns The value.
 */
export function readMigratableSetting(settings: ReadonlyPluginSettings<PluginSettings>, propertyName: MigratableSettingPropertyName): MigratableSettingValue {
  return settings[propertyName];
}

/**
 * Narrows a string to an {@link EmptyFolderBehavior} member, for values arriving from a dropdown.
 *
 * @param value - The value to narrow.
 * @returns The member, or `null` when the string names none.
 */
export function toEmptyFolderBehaviorOrNull(value: string): EmptyFolderBehavior | null {
  return EMPTY_FOLDER_BEHAVIOR_BY_NAME.get(value) ?? null;
}

function checkBoolean(propertyName: MigratableSettingPropertyName, settingValue: MigratableSettingValue): boolean {
  if (typeof settingValue !== 'boolean') {
    throw new TypeError(`Setting "${propertyName}" expects a boolean, got ${JSON.stringify(settingValue)}`);
  }

  return settingValue;
}

function ensureEmptyFolderBehavior(propertyName: MigratableSettingPropertyName, settingValue: MigratableSettingValue): EmptyFolderBehavior {
  const emptyFolderBehavior = typeof settingValue === 'string' ? EMPTY_FOLDER_BEHAVIOR_BY_NAME.get(settingValue) : undefined;
  if (emptyFolderBehavior === undefined) {
    throw new TypeError(`Setting "${propertyName}" expects an empty folder behavior, got ${JSON.stringify(settingValue)}`);
  }

  return emptyFolderBehavior;
}

function ensureStringList(propertyName: MigratableSettingPropertyName, settingValue: MigratableSettingValue): string[] {
  if (typeof settingValue === 'boolean' || typeof settingValue === 'string' || settingValue.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`Setting "${propertyName}" expects a list of strings, got ${JSON.stringify(settingValue)}`);
  }

  return [...settingValue];
}

function writeMigratableSetting(params: WriteMigratableSettingParams): void {
  const {
    propertyName,
    settings,
    value
  } = params;

  switch (propertyName) {
    case 'emptyFolderBehavior': {
      settings.emptyFolderBehavior = ensureEmptyFolderBehavior(propertyName, value);
      break;
    }
    case 'excludePaths': {
      settings.excludePaths = ensureStringList(propertyName, value);
      break;
    }
    case 'includePaths': {
      settings.includePaths = ensureStringList(propertyName, value);
      break;
    }
    case 'notePriorities': {
      settings.notePriorities = ensureStringList(propertyName, value);
      break;
    }
    case 'shouldDeleteConflictingAttachments': {
      settings.shouldDeleteConflictingAttachments = checkBoolean(propertyName, value);
      break;
    }
    case 'shouldHandleDeletions': {
      settings.shouldHandleDeletions = checkBoolean(propertyName, value);
      break;
    }
    case 'shouldHandleRenames': {
      settings.shouldHandleRenames = checkBoolean(propertyName, value);
      break;
    }
    case 'shouldRenameAttachmentFiles': {
      settings.shouldRenameAttachmentFiles = checkBoolean(propertyName, value);
      break;
    }
    case 'shouldRenameAttachmentFolder': {
      settings.shouldRenameAttachmentFolder = checkBoolean(propertyName, value);
      break;
    }
    case 'shouldRescueSharedAttachments': {
      settings.shouldRescueSharedAttachments = checkBoolean(propertyName, value);
      break;
    }
    case 'shouldUpdateFileNameAliases': {
      settings.shouldUpdateFileNameAliases = checkBoolean(propertyName, value);
      break;
    }
    case 'treatAsAttachmentExtensions': {
      settings.treatAsAttachmentExtensions = ensureStringList(propertyName, value);
      break;
    }
    default: {
      assertNever(propertyName);
    }
  }
}
