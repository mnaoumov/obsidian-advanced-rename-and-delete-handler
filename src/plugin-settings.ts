import { PathSettings } from '@mnaoumov/obsidian-lib/path-settings';

import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';

/**
 * What to do when several notes survive a deletion and the note-priority list names no owner among
 * them — the list is empty, nothing in it matched, or the best rank is shared.
 *
 * An enum rather than a toggle because the box this governs is expected to grow more ways of settling
 * the same question, the way its sibling in `Custom Attachment Location` has.
 */
export enum RescueAttachmentUsedByMultipleNotesMode {
  /**
   * Ask which of the notes adopts the attachment, naming them and saying why the list settled nothing.
   */
  Prompt = 'prompt',

  /**
   * Leave the attachment where it is without asking.
   */
  Skip = 'skip'
}

export class PluginSettings {
  /**
   * What to do with a folder a deletion or a move has left empty.
   */
  public emptyFolderBehavior: EmptyFolderBehavior = EmptyFolderBehavior.Keep;

  /**
   * The note-priority list that decides which surviving note adopts an attachment a deletion would
   * otherwise strand. Empty means the user has expressed no preference, and a tie is left unresolved.
   */
  public notePriorities: readonly string[] = [];

  /**
   * What to do when the note-priority list settles nothing and the attachment would be left behind.
   *
   * Asking is the default: the rescue itself is off by default, so a user who reaches this has already
   * asked for surviving attachments to be moved, and being told which notes tie is the only way they
   * can act on it.
   */
  public rescueAttachmentUsedByMultipleNotesMode = RescueAttachmentUsedByMultipleNotesMode.Prompt;

  /**
   * Whether an attachment that collides with an existing file at the destination replaces it.
   *
   * Destructive, so off by default.
   */
  public shouldDeleteConflictingAttachments = false;

  /**
   * Whether {@link emptyFolderBehavior} also applies to the folder a deleted note leaves empty, not only to the
   * attachment folders it leaves empty.
   *
   * Off by default: the folder a note sat in is usually one the user made to file notes in, and Obsidian itself
   * never deletes it with its last note. A settings record from before this setting existed that already deletes
   * empty folders loads it as `true` instead, because that is what such a record used to do (see
   * `PluginSettingsComponent.onLoadRecord`).
   */
  public shouldDeleteEmptyNoteFolders = false;

  /**
   * Whether deleting a note also deletes the attachments only that note referenced.
   *
   * Destructive, so off by default.
   */
  public shouldHandleDeletions = false;

  /**
   * Whether renames and moves are handled at all — this plugin's link update, replacing Obsidian's own.
   *
   * Off by default, together with {@link shouldRenameAttachmentFolder}, so that installing this plugin
   * changes nothing on its own. Other plugins declare it as a dependency and ask the user to install it,
   * and being asked to install something has to be harmless. The values such a plugin used to hold arrive
   * through `migrateSettings` instead, where the user is shown what would change.
   */
  public shouldHandleRenames = false;

  /**
   * Whether renaming a note renames the attachment files that travel with it.
   */
  public shouldRenameAttachmentFiles = false;

  /**
   * Whether renaming a note renames (or moves) its attachment folder alongside it.
   *
   * Independent of {@link shouldHandleRenames}: the attachment move runs with link updates off, so this
   * has to be off as well for a fresh install to do nothing.
   */
  public shouldRenameAttachmentFolder = false;

  /**
   * Whether an attachment that survives a deletion — because another note still references it — is
   * moved into that note's attachment folder rather than left where the deleted note had put it.
   */
  public shouldRescueSharedAttachments = false;

  /**
   * Whether a rename or move that updated links ends with an `Updated N links in M files.` notice.
   *
   * On by default, because that is what every release before this setting did. It silences only that success
   * notice: warnings and errors still show. Not in the published API, since no consumer ever owned it.
   */
  public shouldShowLinkUpdateNotice = true;

  /**
   * Whether renaming a note rewrites the display text of the links that pointed at its old name.
   */
  public shouldUpdateFileNameAliases = true;

  /**
   * Entries that make a file an attachment even though its extension says otherwise — the canonical
   * case being an `Excalidraw` drawing, which is stored as markdown. An entry is an extension such as
   * `.excalidraw.md`, or a `property:name` / `property:name=value` frontmatter match: `Excalidraw` itself
   * recognizes a drawing by its `excalidraw-plugin` property, so one saved without the compound extension
   * is still a drawing.
   */
  public treatAsAttachmentExtensions: readonly string[] = ['.excalidraw.md', 'property:excalidraw-plugin'];

  /**
   * Paths this plugin leaves alone entirely. An entry is a plain path from the vault root, a glob (`*`, `**`,
   * `?`, `[abc]`; no `/` matches a name at any depth, a trailing `/` matches folders only), or a `/pattern/flags`
   * regular expression. Every entry matches case-insensitively.
   */
  public get excludePaths(): string[] {
    return this._pathSettings.excludePaths;
  }

  public set excludePaths(value: string[]) {
    this._pathSettings.excludePaths = value;
  }

  /**
   * Paths this plugin is limited to. Empty — the default — means the whole vault.
   */
  public get includePaths(): string[] {
    return this._pathSettings.includePaths;
  }

  public set includePaths(value: string[]) {
    this._pathSettings.includePaths = value;
  }

  private readonly _pathSettings = new PathSettings();

  public isPathIgnored(path: string, isFolder = false): boolean {
    return this._pathSettings.isPathIgnored(path, isFolder);
  }
}
