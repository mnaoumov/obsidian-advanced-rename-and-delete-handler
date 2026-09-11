import { isTreatedAsAttachment } from 'obsidian-dev-utils/obsidian/file-system';
import { PathSettings } from 'obsidian-dev-utils/obsidian/path-settings';

import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';

/**
 * What to do when several notes survive a deletion and the note-priority list names no owner among
 * them — the list is empty, nothing in it matched, or the best rank is shared.
 *
 * An enum rather than a toggle because the box this governs is expected to grow more ways of settling
 * the same question, the way its sibling in Custom Attachment Location has.
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
   * Whether renaming a note rewrites the display text of the links that pointed at its old name.
   */
  public shouldUpdateFileNameAliases = true;

  /**
   * Extensions whose files are attachments even though their extension says otherwise — the canonical
   * case being `.excalidraw.md`, which is a drawing rather than a note.
   */
  public treatAsAttachmentExtensions: readonly string[] = ['.excalidraw.md'];

  /**
   * Paths this plugin leaves alone entirely. A plain entry is a path from the vault root; an entry
   * wrapped in `/` is a regular expression.
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

  public isPathIgnored(path: string): boolean {
    return this._pathSettings.isPathIgnored(path);
  }

  public isTreatedAsAttachment(path: string): boolean {
    return isTreatedAsAttachment({
      attachmentExtensions: this.treatAsAttachmentExtensions,
      pathOrFile: path
    });
  }
}
