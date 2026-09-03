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
 * The answer also says whether the attachment is one file of a folder that has to travel whole — a
 * `_files` tree, a drawing's sidecar folder. That designation is read off a sibling member on the same
 * patched function, for the same reason and with the same fallback: whoever owns the vault's
 * attachment-path policy owns this too, and a vault with nobody owning it has no units.
 *
 * The answer must be free of side effects: the handler calls this twice for a folder deletion, because
 * the owning note's own deletion re-walks its links afterwards, and performs the move itself once it
 * has a path.
 *
 * Asking the user is the one thing that is not repeatable, which is why the dialog goes through
 * `RescueDecisionScope`: the second call is answered from the first call's recorded answer, so this
 * still behaves identically however many times it is asked about the same attachment.
 */

import type { App } from 'obsidian';

import {
  AttachmentPathContext,
  getAttachmentFolderPath
} from 'obsidian-dev-utils/obsidian/attachment-path';
import { findAttachmentUnitFolderPath } from 'obsidian-dev-utils/obsidian/attachment-unit-folder';
import {
  findNoPriorityWinnerReason,
  findNotePriorityRank,
  pickHighestPriorityNotePath
} from 'obsidian-dev-utils/obsidian/note-priority';
import { join } from 'obsidian-dev-utils/path';

import type { PluginSettingsComponent } from './plugin-settings-component.ts';
import type {
  GetRescuePathParams,
  RescueDestination
} from './rename-delete-handler-component.ts';

import { checkIsAttachmentUnitFolder } from './attachment-unit-folder-designation.ts';
import { RescueAttachmentUsedByMultipleNotesMode } from './plugin-settings.ts';
import { showRescueAmbiguityModal } from './rescue-ambiguity-modal.ts';

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

type RescuePathResolverAskWhoAdoptsParams = GetRescuePathParams;

interface RescuePathResolverConstructorParams {
  readonly app: App;
  readonly pluginSettingsComponent: PluginSettingsComponent;
}

type RescuePathResolverGetRescuePathParams = GetRescuePathParams;

/**
 * The fewest surviving notes that leave anything to choose between. A single survivor wins outright.
 */
const MINIMUM_NOTES_TO_CHOOSE_BETWEEN = 2;

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
   * @returns The destination, or `null` to leave the attachment where it is.
   */
  public async getRescuePath(params: RescuePathResolverGetRescuePathParams): Promise<null | RescueDestination> {
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
    }) ?? await this.askWhoAdopts(params);

    if (notePath === null) {
      return null;
    }

    const attachmentFolderPath = await getAttachmentFolderPath({
      app: this.app,
      context: AttachmentPathContext.DeleteNote,
      notePathOrFile: notePath
    });

    return {
      /*
       * The attachment keeps its name. A rescue relocates a file the user never named, and renaming it as
       * well would compound one surprise with another.
       */
      attachmentPath: join(attachmentFolderPath, attachmentFile.name),

      /*
       * Read off the vault, not off any plugin's settings: whichever attachment-location plugin is
       * installed publishes the designation next to the `extended` this resolver already asks for the
       * attachment folder, and a vault running none answers "no unit" — which is the behavior this plugin
       * had before it asked at all.
       */
      unitFolderPath: findAttachmentUnitFolderPath({
        attachmentPath: params.attachmentPath,
        checkIsAttachmentUnitFolder: (folderPath) => checkIsAttachmentUnitFolder({ folderPath, vault: this.app.vault })
      })
    };
  }

  /**
   * Asks the user which surviving note adopts the attachment, once the priority list has settled nothing.
   *
   * Leaving the attachment in place is safe, but it also keeps the folder holding it alive, and the user
   * is told neither which notes are responsible nor why their list did not decide. The dialog answers
   * both and turns the answer into one click.
   *
   * The question goes through the deletion's `RescueDecisionScope` rather than straight to the dialog,
   * because one folder deletion asks this hook twice about the same attachment and the two asks overlap
   * in time. The scope makes the second one join the first instead of opening a second dialog over the
   * same file — which would leave a deletion waiting forever on an answer the user has already given.
   *
   * @param params - The parameters provided by the rename/delete handler.
   * @returns The adopting note's path, or `null` to leave the attachment where it is.
   */
  private async askWhoAdopts(params: RescuePathResolverAskWhoAdoptsParams): Promise<null | string> {
    if (this.pluginSettingsComponent.settings.rescueAttachmentUsedByMultipleNotesMode !== RescueAttachmentUsedByMultipleNotesMode.Prompt) {
      return null;
    }

    /*
     * A single survivor never reaches here — it wins outright — so anything short of two notes is a
     * deletion with nothing to choose between, and there is no question to put.
     */
    if (params.survivingNotePaths.length < MINIMUM_NOTES_TO_CHOOSE_BETWEEN) {
      return null;
    }

    const survivingNotePaths = [...params.survivingNotePaths].sort((a, b) => a.localeCompare(b));
    const entries = this.pluginSettingsComponent.settings.notePriorities;

    const decision = await params.rescueDecisionScope.resolveDecision({
      ask: async () => {
        const answer = await showRescueAmbiguityModal({
          app: this.app,
          attachmentPath: params.attachmentPath,
          /*
           * Mirrors the same conditions `pickRescueNotePath` just failed on rather than re-deciding
           * anything, so the reason shown can only ever agree with the outcome.
           */
          noPriorityWinnerReason: findNoPriorityWinnerReason({
            entries,
            notePaths: survivingNotePaths,
            rank: (candidateNotePath) => this.findRank(candidateNotePath)
          }),
          survivingNotePaths
        });

        return {
          decision: { adoptingNotePath: answer.adoptingNotePath },
          shouldUseSameActionForRest: answer.shouldUseSameActionForRest
        };
      },
      attachmentPath: params.attachmentPath,
      survivingNotePaths
    });

    return decision.adoptingNotePath;
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
