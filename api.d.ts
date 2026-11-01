/**
 * The API this plugin publishes for other plugins to call.
 *
 * Copy this file into your own plugin: it imports nothing at all, so it costs you no dependency on this plugin and none
 * on `@mnaoumov/obsidian-lib`. That is why {@link EmptyFolderBehavior} — which the plugin itself takes from that library as
 * an enum — is inlined below as a plain string-literal union. It carries the same runtime values the plugin uses.
 *
 * The API is reached through the `@mnaoumov/obsidian-lib` cross-plugin API registry, keyed by the plugin id
 * `advanced-rename-and-delete-handler` and version-negotiated against its CONTRACT version, which moves independently of
 * the plugin's own `manifest.version`. `1.1.0` added the three read-back members to `1.0.0`'s `migrateSettings`, and
 * `1.2.0` added {@link HandedOverSettings.shouldDeleteEmptyNoteFolders}, and `1.3.0` added
 * {@link AdvancedRenameAndDeleteHandlerApi.moveMany} and {@link AdvancedRenameAndDeleteHandlerApi.runInBatch}, all purely
 * additively, so ask for `^1` — or `^1.3.0` when you call one of the two bulk-move members. The README's `For plugin developers` section shows both routes: `watchPluginApi` for a
 * consumer that already has `@mnaoumov/obsidian-lib`, and the library-free registry read for one that does not.
 */

/**
 * What to do with a folder a deletion or a move has left empty.
 *
 * - `Keep` leaves it.
 * - `Delete` deletes it.
 * - `DeleteWithEmptyParents` deletes it, and then every parent that deleting it left empty in turn.
 */
export type EmptyFolderBehavior = 'Delete' | 'DeleteWithEmptyParents' | 'Keep';

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
  getSettings: () => HandedOverSettings;

  /**
   * Whether this plugin leaves the path alone entirely, per its include and exclude lists.
   *
   * Handed over as a predicate rather than left to the caller to recompute from
   * {@link HandedOverSettings.excludePaths} / {@link HandedOverSettings.includePaths}: every plugin bundles
   * its own `@mnaoumov/obsidian-lib`, so two copies of the matching code are two copies that can drift apart.
   *
   * @param path - The path to test, from the vault root.
   * @returns `true` when the path is ignored.
   */
  isPathIgnored: (path: string) => boolean;

  /**
   * Whether the path names an attachment even though its extension says otherwise — an `Excalidraw` drawing
   * being the case that motivated the setting, recognized by its `.excalidraw.md` extension or, through a
   * `property:excalidraw-plugin` entry, by its frontmatter.
   *
   * A `property:` entry reads the metadata cache, so a markdown file Obsidian has not indexed yet matches no
   * such entry and is answered `false` until it has.
   *
   * A predicate for the same reason as {@link AdvancedRenameAndDeleteHandlerApi.isPathIgnored}: the matching
   * stays in one place rather than being re-derived from
   * {@link HandedOverSettings.treatAsAttachmentExtensions} by each consumer's own library copy.
   *
   * @param path - The path to test, from the vault root.
   * @returns `true` when the path is treated as an attachment.
   */
  isTreatedAsAttachment: (path: string) => boolean;

  /**
   * Offers the user a set of settings values another plugin proposes, and applies what they approve.
   *
   * Resolves only once the dialog is closed, so the caller learns whether the migration happened and can
   * set — or withhold — its own one-shot flag on that answer.
   *
   * @param params - The proposal.
   * @returns What the user approved.
   */
  migrateSettings: (params: MigrateSettingsParams) => Promise<MigrateSettingsResult>;

  /**
   * Moves many files at once and keeps every link pointing where it pointed, rewriting each affected note ONCE.
   *
   * Every link a move affects is resolved first, while the vault is still as it was: each moved note's own links
   * and every link to a moved file. Then all the files move with no link update in between, the folders the moves
   * left empty are handled per {@link HandedOverSettings.emptyFolderBehavior}, and each affected note is rewritten
   * once against the final layout. So the result does not depend on the order of the moves, and two moved notes
   * that link each other both end up right.
   *
   * It moves exactly the files in {@link MoveManyParams.moves} and nothing else: attachments do NOT follow their
   * note the way they do on a single rename, so list them too. That is deliberate. A caller that plans a bulk move
   * already knows where every file should go, and an implicit attachment move per note would put back the
   * per-file work this member exists to skip. It acts whatever {@link HandedOverSettings.shouldHandleRenames} and
   * the include and exclude lists say, because the caller asked for it explicitly. Links held in canvas files are
   * not followed.
   *
   * Resolves once every file is moved and every affected note is rewritten, so the links are final when it does.
   * Rejects before moving anything when a source does not exist, a target already exists, or two moves share a
   * source or a target. Only one bulk operation runs at a time: it rejects while another `moveMany` or
   * {@link AdvancedRenameAndDeleteHandlerApi.runInBatch} is running. Added in contract `1.3.0`.
   *
   * @param params - The moves.
   * @returns A promise that resolves once the links are final.
   */
  moveMany: (params: MoveManyParams) => Promise<void>;

  /**
   * Runs `operation`, which renames many files through `app.fileManager.renameFile`, and rewrites each note that
   * links to them once, after all of them, instead of once per renamed file.
   *
   * Each rename is still handled as it happens: the file moves, its attachments follow it per the settings, and
   * the renamed note's own links are rewritten. Only the rewrites of OTHER notes' links are held back, and each
   * such note is written once at the end, with paths followed through every rename the batch made. Use it when
   * the renames should behave exactly like the user's own, attachments included, and
   * {@link AdvancedRenameAndDeleteHandlerApi.moveMany} when the caller has the whole plan and wants it fast.
   *
   * With {@link HandedOverSettings.shouldHandleRenames} off, this plugin handles no rename, so nothing is held
   * back and Obsidian updates the links itself as usual.
   *
   * Resolves once `operation` has resolved and every held-back link is rewritten, so the links are final when it
   * does; rejects with `operation`'s own error when it throws. A rename inside `operation` must not reuse a path
   * that another rename in it freed. Only one bulk operation runs at a time: it rejects while another
   * `runInBatch` or {@link AdvancedRenameAndDeleteHandlerApi.moveMany} is running. Added in contract `1.3.0`.
   *
   * @param operation - Performs the renames.
   * @returns A promise that resolves once the links are final.
   */
  runInBatch: (operation: () => Promise<void>) => Promise<void>;
}

/**
 * One file for {@link AdvancedRenameAndDeleteHandlerApi.moveMany} to move.
 */
export interface FileMove {
  /**
   * Where to move it, from the vault root. Must not exist yet; a missing parent folder is created.
   */
  readonly newPath: string;

  /**
   * The file to move, by its current path from the vault root.
   */
  readonly oldPath: string;
}

/**
 * Parameters for {@link AdvancedRenameAndDeleteHandlerApi.moveMany}.
 */
export interface MoveManyParams {
  /**
   * The files to move. Each source and each target may appear only once.
   */
  readonly moves: readonly FileMove[];
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
   * Whether {@link HandedOverSettings.emptyFolderBehavior} also applies to the folder a deleted note leaves empty,
   * not only to the attachment folders it leaves empty. Added in contract `1.2.0`.
   */
  readonly shouldDeleteEmptyNoteFolders: boolean;

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
   * Entries that make a file an attachment even though its extension says otherwise: an extension such as
   * `.excalidraw.md`, or a `property:name` / `property:name=value` frontmatter match.
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
