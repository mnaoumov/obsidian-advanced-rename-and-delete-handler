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
 * Handing the settings over is not the end of the consumer's interest in them: the same values drive
 * features of its own that have nothing to do with a rename or a delete. So the API also reads them back —
 * synchronously, live, and with the path and attachment matching handed over as predicates rather than as
 * arrays each consumer would re-match with its own bundled copy of the library.
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
   * The settings this plugin holds right now, as plain data.
   *
   * Synchronous and read live on every call, so there is nothing to invalidate and nothing to subscribe to:
   * a consumer calls it from inside a `checkCallback(isChecking): boolean`, a settings row's `disabled` /
   * `visible` predicate, or a loop over vault files, none of which can `await`.
   *
   * The arrays are copies, so writing to one changes nothing here.
   *
   * @returns The current values.
   */
  getSettings(): HandedOverSettings;

  /**
   * Whether this plugin leaves the path alone entirely, per its include and exclude lists.
   *
   * Handed over as a predicate rather than left to the caller to recompute from
   * {@link HandedOverSettings.excludePaths} / {@link HandedOverSettings.includePaths}: every plugin bundles
   * its own `obsidian-dev-utils`, so two copies of the matching code are two copies that can drift apart.
   *
   * @param path - The path to test, from the vault root.
   * @returns `true` when the path is ignored.
   */
  isPathIgnored(path: string): boolean;

  /**
   * Whether the path names an attachment even though its extension says otherwise — `.excalidraw.md` being
   * the case that motivated the setting.
   *
   * A predicate for the same reason as {@link AdvancedRenameAndDeleteHandlerApi.isPathIgnored}: the matching
   * stays in one place rather than being re-derived from
   * {@link HandedOverSettings.treatAsAttachmentExtensions} by each consumer's own library copy.
   *
   * @param path - The path to test, from the vault root.
   * @returns `true` when the path is treated as an attachment.
   */
  isTreatedAsAttachment(path: string): boolean;

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
 * The settings this plugin owns on its consumers' behalf, and hands back through
 * {@link AdvancedRenameAndDeleteHandlerApi.getSettings}.
 *
 * A consumer that hands its rename/delete handler over does not stop caring about these values — they drive
 * features of its own that have nothing to do with a rename or a delete. Reading them back here is what
 * keeps it from having to shadow settings this plugin now owns.
 */
export interface HandedOverSettings {
  /**
   * What to do with a folder a deletion or a move has left empty.
   */
  readonly emptyFolderBehavior: EmptyFolderBehavior;

  /**
   * Paths this plugin leaves alone entirely.
   */
  readonly excludePaths: readonly string[];

  /**
   * Paths this plugin is limited to. Empty means the whole vault.
   */
  readonly includePaths: readonly string[];

  /**
   * Which surviving note adopts an attachment a deletion would otherwise strand, highest priority first.
   */
  readonly notePriorities: readonly string[];

  /**
   * Whether an attachment that collides with an existing file at the destination replaces it.
   */
  readonly shouldDeleteConflictingAttachments: boolean;

  /**
   * Whether deleting a note also deletes the attachments only that note referenced.
   */
  readonly shouldHandleDeletions: boolean;

  /**
   * Whether renames and moves are handled at all.
   */
  readonly shouldHandleRenames: boolean;

  /**
   * Whether renaming a note renames the attachment files that travel with it.
   */
  readonly shouldRenameAttachmentFiles: boolean;

  /**
   * Whether renaming a note renames (or moves) its attachment folder alongside it.
   */
  readonly shouldRenameAttachmentFolder: boolean;

  /**
   * Whether an attachment that survives a deletion is moved into the surviving note's attachment folder.
   */
  readonly shouldRescueSharedAttachments: boolean;

  /**
   * Whether renaming a note rewrites the display text of the links that pointed at its old name.
   */
  readonly shouldUpdateFileNameAliases: boolean;

  /**
   * Extensions whose files are attachments even though their extension says otherwise.
   */
  readonly treatAsAttachmentExtensions: readonly string[];
}

/**
 * The settings a consumer may propose. Every member is optional: a consumer proposes only what it held.
 *
 * Derived from {@link HandedOverSettings} rather than restated, so what can be proposed and what can be read
 * back stay the same set — a fact the compiler holds, instead of two lists that have to be kept in step.
 */
export type MigratableSettings = Partial<HandedOverSettings>;

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
  getSettings: {},
  isPathIgnored: {},
  isTreatedAsAttachment: {},
  migrateSettings: {}
};

/**
 * The version of the contract above — independent of the plugin's own version.
 *
 * `1.1.0` added the read-back members; that is purely additive, so consumers still ask for `'^1'`.
 */
export const PLUGIN_API_VERSION = '1.1.0';
