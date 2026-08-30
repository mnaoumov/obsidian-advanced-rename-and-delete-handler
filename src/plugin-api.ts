/**
 * @file
 *
 * This plugin's public cross-plugin API.
 *
 * A plugin that used to own a rename/delete handler of its own hands its settings over here at the release
 * that stops owning one: it proposes the values it held, this plugin shows the user what would change, and
 * the user approves, edits or declines. The proposal is a suggestion — this plugin owns the settings, so it
 * owns the dialog too, and the consumer never writes into another plugin's `data.json`.
 *
 * Published through the `obsidian-dev-utils` registry, so a consumer gets version negotiation, a handle that
 * is revoked when this plugin unloads, and a wait that ends when this plugin loads rather than a lookup that
 * returns `undefined` because it ran first.
 */

import type { PluginApiContract } from 'obsidian-dev-utils/obsidian/plugin/plugin-api';

import type { EmptyFolderBehavior } from './rename-delete-handler-component.ts';

/**
 * This plugin's API, as a consumer sees it.
 */
export interface AdvancedRenameAndDeleteHandlerApi {
  /**
   * Offers the user a set of settings values another plugin proposes, and applies what they approve.
   *
   * Resolves only once the dialog is closed, so the caller learns whether the migration happened and can
   * set — or withhold — its own one-shot flag on that answer.
   *
   * @param params - The proposal.
   * @returns What the user approved.
   */
  migrateSettings(params: MigrateSettingsParams): Promise<MigrateSettingsResult>;
}

/**
 * The settings a consumer may propose. Every member is optional: a consumer proposes only what it held.
 */
export interface MigratableSettings {
  /**
   * What to do with a folder a deletion or a move has left empty.
   */
  readonly emptyFolderBehavior?: EmptyFolderBehavior;

  /**
   * Paths this plugin leaves alone entirely.
   */
  readonly excludePaths?: readonly string[];

  /**
   * Paths this plugin is limited to. Empty means the whole vault.
   */
  readonly includePaths?: readonly string[];

  /**
   * Which surviving note adopts an attachment a deletion would otherwise strand, highest priority first.
   */
  readonly notePriorities?: readonly string[];

  /**
   * Whether an attachment that collides with an existing file at the destination replaces it.
   */
  readonly shouldDeleteConflictingAttachments?: boolean;

  /**
   * Whether deleting a note also deletes the attachments only that note referenced.
   */
  readonly shouldHandleDeletions?: boolean;

  /**
   * Whether renames and moves are handled at all.
   */
  readonly shouldHandleRenames?: boolean;

  /**
   * Whether renaming a note renames the attachment files that travel with it.
   */
  readonly shouldRenameAttachmentFiles?: boolean;

  /**
   * Whether renaming a note renames (or moves) its attachment folder alongside it.
   */
  readonly shouldRenameAttachmentFolder?: boolean;

  /**
   * Whether an attachment that survives a deletion is moved into the surviving note's attachment folder.
   */
  readonly shouldRescueSharedAttachments?: boolean;

  /**
   * Whether renaming a note rewrites the display text of the links that pointed at its old name.
   */
  readonly shouldUpdateFileNameAliases?: boolean;

  /**
   * Extensions whose files are attachments even though their extension says otherwise.
   */
  readonly treatAsAttachmentExtensions?: readonly string[];
}

/**
 * Parameters for {@link AdvancedRenameAndDeleteHandlerApi.migrateSettings}.
 */
export interface MigrateSettingsParams {
  /**
   * The values the calling plugin proposes.
   */
  readonly proposedSettings: MigratableSettings;

  /**
   * The `manifest.id` of the plugin making the proposal. Shown in the dialog, so the user knows whose
   * settings they are being offered.
   */
  readonly sourcePluginId: string;
}

/**
 * The outcome of {@link AdvancedRenameAndDeleteHandlerApi.migrateSettings}.
 */
export interface MigrateSettingsResult {
  /**
   * Whether the user approved the migration. `false` means they cancelled and nothing was written — the
   * caller should NOT record the migration as done.
   */
  readonly isApplied: boolean;
}

/**
 * The contract this plugin publishes. It declares the method names; the payloads are checked as they are
 * written, by a converter that refuses a value of the wrong type rather than storing it.
 *
 * A consumer that wants schema validation at the boundary supplies its own contract to `watchPluginApi` —
 * the consumer's contract wins when it supplies one.
 */
export const PLUGIN_API_CONTRACT: PluginApiContract = {
  migrateSettings: {}
};

/**
 * The version of the contract above — independent of the plugin's own version.
 *
 * Consumers ask for `'^1'`.
 */
export const PLUGIN_API_VERSION = '1.0.0';
