/**
 * @file
 *
 * Imports, once, the rename/delete settings that used to live in each consumer plugin.
 *
 * Before this plugin existed, five plugins each carried their own copy of the rename/delete settings
 * and `obsidian-dev-utils` merged them at runtime: booleans by OR, ignored paths by union. A user
 * arriving here has those answers spread across up to five `data.json` files, and asking them to
 * re-enter the lot would be a regression dressed as a migration. So the same merge runs once, over the
 * files themselves.
 *
 * Reading the files rather than the loaded plugin instances is deliberate: a consumer the user has
 * since disabled still holds settings worth importing, and its instance is not there to ask.
 *
 * The merge is deliberately lossy in one direction only — it can turn a behavior ON that a single
 * consumer had off, exactly as the runtime merge already did. It never turns one off.
 */

import type { App } from 'obsidian';

import type { PluginSettings } from './plugin-settings.ts';

import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';

/**
 * A consumer plugin whose rename/delete settings are imported, and how its keys map onto ours.
 */
interface LegacyConsumer {
  /**
   * Reads the consumer's persisted settings into ours.
   *
   * @param legacySettings - The consumer's parsed `data.json`.
   * @param settings - The settings being built up. Mutated in place.
   */
  apply(this: void, legacySettings: Record<string, unknown>, settings: PluginSettings): void;

  /**
   * The consumer's plugin id, which is also its folder name under the config directory.
   */
  readonly pluginId: string;
}

const LEGACY_CONSUMERS: readonly LegacyConsumer[] = [
  {
    apply: (legacySettings, settings): void => {
      applyEmptyFolderBehavior(legacySettings['emptyFolderBehavior'], settings);
      orInto(settings, 'shouldHandleDeletions', legacySettings['shouldDeleteOrphanAttachments']);
      orInto(settings, 'shouldHandleRenames', legacySettings['shouldHandleRenames']);
      orInto(settings, 'shouldRenameAttachmentFiles', legacySettings['shouldRenameAttachmentFiles']);
      orInto(settings, 'shouldRenameAttachmentFolder', legacySettings['shouldRenameAttachmentFolder']);
      orInto(settings, 'shouldRescueSharedAttachments', legacySettings['shouldRescueSharedAttachments']);
      unionExtensionsInto(settings, legacySettings['treatAsAttachmentExtensions']);
      unionNotePrioritiesInto(settings, legacySettings['notePriorities']);
      unionPathsInto(settings, legacySettings);
    },
    pluginId: 'obsidian-custom-attachment-location'
  },
  {
    apply: (legacySettings, settings): void => {
      applyEmptyFolderBehavior(legacySettings['emptyFolderBehavior'], settings);
      orInto(settings, 'shouldDeleteConflictingAttachments', legacySettings['shouldDeleteExistingFilesWhenMovingNote']);
      orInto(settings, 'shouldHandleDeletions', legacySettings['shouldDeleteAttachmentsWithNote']);
      orInto(settings, 'shouldHandleRenames', legacySettings['shouldUpdateLinks']);
      orInto(settings, 'shouldRenameAttachmentFolder', legacySettings['shouldMoveAttachmentsWithNote']);
      orInto(settings, 'shouldUpdateFileNameAliases', legacySettings['shouldChangeNoteBacklinksDisplayText']);
      unionExtensionsInto(settings, legacySettings['treatAsAttachmentExtensions']);
      unionPathsInto(settings, legacySettings);
    },
    pluginId: 'consistent-attachments-and-links'
  },
  {
    apply: (legacySettings, settings): void => {
      orInto(settings, 'shouldHandleRenames', legacySettings['shouldAutomaticallyUpdateLinksOnRenameOrMove']);
      unionPathsInto(settings, legacySettings);
    },
    pluginId: 'better-markdown-links'
  },
  {
    apply: (legacySettings, settings): void => {
      orInto(settings, 'shouldHandleRenames', legacySettings['shouldUpdateLinks']);
    },
    pluginId: 'external-rename-handler'
  },
  {
    apply: (legacySettings, settings): void => {
      orInto(settings, 'shouldHandleRenames', legacySettings['shouldHandleRenames']);
    },
    pluginId: 'frontmatter-markdown-links'
  }
];

/**
 * The result of {@link migrateLegacySettings}.
 */
export interface MigrateLegacySettingsResult {
  /**
   * The ids of the consumer plugins whose settings were actually read.
   */
  readonly importedFromPluginIds: readonly string[];
}

/**
 * Imports the consumer plugins' rename/delete settings into ours.
 *
 * @param app - The Obsidian app instance.
 * @param settings - The settings to merge into. Mutated in place.
 * @returns Which consumers contributed.
 */
export async function migrateLegacySettings(app: App, settings: PluginSettings): Promise<MigrateLegacySettingsResult> {
  const importedFromPluginIds: string[] = [];

  for (const consumer of LEGACY_CONSUMERS) {
    const legacySettings = await readPluginData(app, consumer.pluginId);
    if (!legacySettings) {
      continue;
    }
    consumer.apply(legacySettings, settings);
    importedFromPluginIds.push(consumer.pluginId);
  }

  return { importedFromPluginIds };
}

/**
 * Adopts a consumer's empty-folder behavior, first answer winning.
 *
 * Unlike the booleans there is no "more of it" direction to merge along, so the library's own
 * first-one-answers rule is kept rather than inventing a precedence the user never chose.
 *
 * @param value - The consumer's persisted value.
 * @param settings - The settings being built up.
 */
function applyEmptyFolderBehavior(value: unknown, settings: PluginSettings): void {
  if (settings.emptyFolderBehavior !== EmptyFolderBehavior.Keep) {
    return;
  }
  if (typeof value === 'string' && isEmptyFolderBehavior(value)) {
    settings.emptyFolderBehavior = value;
  }
}

function isEmptyFolderBehavior(value: string): value is EmptyFolderBehavior {
  return Object.values(EmptyFolderBehavior).some((behavior) => String(behavior) === value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * ORs a consumer's boolean into ours, mirroring the runtime merge this replaces.
 *
 * @param settings - The settings being built up.
 * @param propertyName - The property to merge into.
 * @param value - The consumer's persisted value, of unknown shape.
 */
function orInto(
  settings: PluginSettings,
  propertyName: 'shouldDeleteConflictingAttachments' | 'shouldHandleDeletions' | 'shouldHandleRenames' | 'shouldRenameAttachmentFiles' | 'shouldRenameAttachmentFolder' | 'shouldRescueSharedAttachments' | 'shouldUpdateFileNameAliases',
  value: unknown
): void {
  if (value === true) {
    settings[propertyName] = true;
  }
}

/**
 * Reads a plugin's persisted settings.
 *
 * The path is built from `Vault#configDir` rather than a literal `.obsidian`, which the user can rename.
 *
 * @param app - The Obsidian app instance.
 * @param pluginId - The plugin whose data to read.
 * @returns The parsed settings, or `null` when the plugin has never been installed or stored anything
 * usable.
 */
async function readPluginData(app: App, pluginId: string): Promise<null | Record<string, unknown>> {
  const dataPath = `${app.vault.configDir}/plugins/${pluginId}/data.json`;
  if (!await app.vault.adapter.exists(dataPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await app.vault.adapter.read(dataPath));
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  return parsed as Record<string, unknown>;
}

function unionExtensionsInto(settings: PluginSettings, value: unknown): void {
  if (!isStringArray(value)) {
    return;
  }
  settings.treatAsAttachmentExtensions = [...new Set([...settings.treatAsAttachmentExtensions, ...value])];
}

function unionNotePrioritiesInto(settings: PluginSettings, value: unknown): void {
  if (!isStringArray(value)) {
    return;
  }
  settings.notePriorities = [...new Set([...settings.notePriorities, ...value])];
}

/**
 * Unions a consumer's include / exclude path lists into ours.
 *
 * The union matches how the library composed them: an exclusion from any consumer excluded the path for
 * all of them.
 *
 * @param settings - The settings being built up.
 * @param legacySettings - The consumer's parsed `data.json`.
 */
function unionPathsInto(settings: PluginSettings, legacySettings: Record<string, unknown>): void {
  const excludePaths = legacySettings['excludePaths'];
  if (isStringArray(excludePaths)) {
    settings.excludePaths = [...new Set([...settings.excludePaths, ...excludePaths])];
  }

  const includePaths = legacySettings['includePaths'];
  if (isStringArray(includePaths)) {
    settings.includePaths = [...new Set([...settings.includePaths, ...includePaths])];
  }
}
