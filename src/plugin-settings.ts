import { isTreatedAsAttachment } from 'obsidian-dev-utils/obsidian/file-system';
import { PathSettings } from 'obsidian-dev-utils/obsidian/path-settings';

import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';

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
   * Whether renames and moves are handled at all. This is the plugin's reason to exist, so it is on.
   */
  public shouldHandleRenames = true;

  /**
   * Whether renaming a note renames the attachment files that travel with it.
   */
  public shouldRenameAttachmentFiles = false;

  /**
   * Whether renaming a note renames (or moves) its attachment folder alongside it.
   */
  public shouldRenameAttachmentFolder = true;

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
