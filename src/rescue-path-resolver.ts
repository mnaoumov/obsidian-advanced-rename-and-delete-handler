/**
 * @file
 *
 * Decides where an attachment goes when the deletion of a note would otherwise strand it.
 *
 * Deleting a note whose attachment another note still references does not destroy the attachment. What
 * has to be decided is where the survivor should live, and this plugin answers with the attachment
 * folder of the note that adopts it.
 *
 * Resolving that folder needs no knowledge of any other plugin. `getAttachmentFolderPath` routes
 * through `app.vault.getAvailablePathForAttachments.extended` when an attachment-location plugin has
 * installed one, and falls back to Obsidian's own configured folder when none has — so a vault running
 * a custom attachment-path policy gets that policy here, and a plain vault gets the plain answer.
 *
 * The answer must be free of side effects: the handler calls this twice for a folder deletion, because
 * the owning note's own deletion re-walks its links afterwards, and performs the move itself once it
 * has a path.
 */

import type { App } from 'obsidian';

import {
  AttachmentPathContext,
  getAttachmentFolderPath
} from 'obsidian-dev-utils/obsidian/attachment-path';
import {
  findNotePriorityRank,
  pickHighestPriorityNotePath
} from 'obsidian-dev-utils/obsidian/note-priority';
import { join } from 'obsidian-dev-utils/path';

import type { PluginSettingsComponent } from './plugin-settings-component.ts';
import type { GetRescuePathParams } from './rename-delete-handler-component.ts';

/**
 * Parameters for {@link pickRescueNotePath}.
 */
export interface PickRescueNotePathParams {
  /**
   * The priority list, highest priority first. Empty means the user has expressed no preference.
   */
  readonly entries: readonly string[];

  /**
   * The priority rank of a note. Lower wins.
   *
   * @param notePath - The vault-relative path of the note.
   * @returns The rank.
   */
  rank(this: void, notePath: string): number;

  /**
   * The vault-relative paths of the notes that still reference the attachment once the deletion is done.
   */
  readonly survivingNotePaths: readonly string[];
}

interface RescuePathResolverConstructorParams {
  readonly app: App;
  readonly pluginSettingsComponent: PluginSettingsComponent;
}

type RescuePathResolverGetRescuePathParams = GetRescuePathParams;

export class RescuePathResolver {
  private readonly app: App;
  private readonly pluginSettingsComponent: PluginSettingsComponent;

  public constructor(params: RescuePathResolverConstructorParams) {
    this.app = params.app;
    this.pluginSettingsComponent = params.pluginSettingsComponent;
  }

  /**
   * Resolves where an attachment about to be stranded should be moved to.
   *
   * @param params - The parameters provided by the rename/delete handler.
   * @returns The destination path, or `null` to leave the attachment where it is.
   */
  public async getRescuePath(params: RescuePathResolverGetRescuePathParams): Promise<null | string> {
    if (!this.pluginSettingsComponent.settings.shouldRescueSharedAttachments) {
      return null;
    }

    const attachmentFile = this.app.vault.getFileByPath(params.attachmentPath);
    if (!attachmentFile) {
      return null;
    }

    const notePath = pickRescueNotePath({
      entries: this.pluginSettingsComponent.settings.notePriorities,
      rank: (candidateNotePath) => this.findRank(candidateNotePath),
      survivingNotePaths: params.survivingNotePaths
    });

    if (notePath === null) {
      return null;
    }

    const attachmentFolderPath = await getAttachmentFolderPath({
      app: this.app,
      context: AttachmentPathContext.DeleteNote,
      notePathOrFile: notePath
    });

    /*
     * The attachment keeps its name. A rescue relocates a file the user never named, and renaming it as
     * well would compound one surprise with another.
     */
    return join(attachmentFolderPath, attachmentFile.name);
  }

  private findRank(notePath: string): number {
    const noteFile = this.app.vault.getFileByPath(notePath);
    return findNotePriorityRank({
      entries: this.pluginSettingsComponent.settings.notePriorities,
      frontmatter: noteFile ? this.app.metadataCache.getFileCache(noteFile)?.frontmatter ?? null : null,
      notePath
    });
  }
}

/**
 * Picks the note whose attachment folder a stranded attachment should be moved into.
 *
 * A single surviving note wins outright, WITHOUT consulting the priority list. That list is empty by
 * default, so ranking first would mean the rescue never fired for anybody who had not filled it in —
 * and with only one note left there is nothing to rank anyway.
 *
 * Several surviving notes fall to {@link pickHighestPriorityNotePath}, which returns `null` on a tie or
 * when nothing matched. `null` here means "leave it in place", which is the conservative answer to an
 * ambiguity the user has not resolved.
 *
 * @param params - The parameters for picking the note.
 * @returns The winning note's path, or `null` when there is no single winner.
 */
export function pickRescueNotePath(params: PickRescueNotePathParams): null | string {
  const [firstNotePath] = params.survivingNotePaths;
  if (firstNotePath !== undefined && params.survivingNotePaths.length === 1) {
    return firstNotePath;
  }

  if (params.entries.length === 0) {
    return null;
  }

  return pickHighestPriorityNotePath({
    notePaths: params.survivingNotePaths,
    rank: (notePath) => params.rank(notePath)
  });
}
