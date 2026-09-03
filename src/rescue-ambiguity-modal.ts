/**
 * @file
 *
 * The dialog shown when a deletion would strand an attachment and the note-priority list cannot say
 * which surviving note should adopt it.
 *
 * Leaving the attachment in place is safe but opaque: the folder holding it survives too, and the user
 * is told neither which notes are keeping it alive nor why their priority list settled nothing. This
 * dialog answers both, and turns the answer into one click — the chosen note adopts the attachment, and
 * the folder is then free to go.
 *
 * The reason comes from `findNoPriorityWinnerReason`, which exists precisely so a caller can name the
 * real cause rather than only reporting that several notes reference the file. Its sibling in Custom
 * Attachment Location shows the same three reasons on the collecting path.
 */

import type { App } from 'obsidian';
import type { PromiseResolve } from 'obsidian-dev-utils/async';

import {
  ButtonComponent,
  Setting,
  ToggleComponent
} from 'obsidian';
import { invokeAsyncSafely } from 'obsidian-dev-utils/async';
import { renderInternalLink } from 'obsidian-dev-utils/obsidian/markdown';
import {
  ModalBase,
  showModal
} from 'obsidian-dev-utils/obsidian/modals/modal';
import { NoPriorityWinnerReason } from 'obsidian-dev-utils/obsidian/note-priority';
import { basename } from 'obsidian-dev-utils/path';
import { assertNever } from 'obsidian-dev-utils/type-guards';

/**
 * How the user settled an attachment the priority list could not place.
 */
export interface RescueAmbiguityDecision {
  /**
   * The note that adopts the attachment, or `null` to leave the attachment where it is.
   */
  readonly adoptingNotePath: null | string;

  /**
   * Whether the same answer should stand for the rest of this deletion, without asking again.
   */
  readonly shouldUseSameActionForRest: boolean;
}

/**
 * Parameters for {@link showRescueAmbiguityModal}.
 */
export interface ShowRescueAmbiguityModalParams {
  /**
   * An Obsidian app instance.
   */
  readonly app: App;

  /**
   * The attachment that would be stranded.
   */
  readonly attachmentPath: string;

  /**
   * Why the note-priority list named no owner.
   */
  readonly noPriorityWinnerReason: NoPriorityWinnerReason;

  /**
   * The notes that still reference the attachment, in the order they should be offered.
   */
  readonly survivingNotePaths: readonly string[];
}

interface RescueAmbiguityModalConstructorParams extends ShowRescueAmbiguityModalParams {
  readonly promiseResolve: PromiseResolve<RescueAmbiguityDecision>;
}

const LEAVE_IT_HERE: RescueAmbiguityDecision = {
  adoptingNotePath: null,
  shouldUseSameActionForRest: false
};

class RescueAmbiguityModal extends ModalBase<RescueAmbiguityDecision> {
  private readonly attachmentPath: string;
  private decision: null | RescueAmbiguityDecision = null;
  private readonly noPriorityWinnerReason: NoPriorityWinnerReason;
  private shouldUseSameActionForRest = false;
  private readonly survivingNotePaths: readonly string[];

  public constructor(params: RescueAmbiguityModalConstructorParams) {
    super(params);
    this.attachmentPath = params.attachmentPath;
    this.noPriorityWinnerReason = params.noPriorityWinnerReason;
    this.survivingNotePaths = params.survivingNotePaths;
  }

  public override onClose(): void {
    /*
     * Dismissing the dialog is not an answer, so it means the conservative one: leave the attachment
     * exactly where the user last saw it. Mirrors the collecting dialog, which treats a close as Cancel.
     */
    this.promiseResolve(this.decision ?? LEAVE_IT_HERE);
  }

  public override onOpen(): void {
    super.onOpen();
    this.titleEl.setText('Attachment used by several notes');

    this.contentEl.createEl('p', {
      text: `${this.attachmentPath} survives this deletion because other notes still reference it, so the folder holding it survives too.`
    });

    /*
     * The links render asynchronously, but everything the user acts on is built synchronously below, so
     * the dialog is never a dead box waiting on a render.
     */
    const referencesEl = this.contentEl.createDiv();

    this.contentEl.createEl('p', {
      cls: 'advanced-rename-and-delete-handler rescue-ambiguity-reason',
      text: getNoPriorityWinnerReasonText(this.noPriorityWinnerReason)
    });

    this.contentEl.createEl('p', {
      text: 'Pick the note that should adopt it, or leave it where it is.'
    });

    new Setting(this.contentEl)
      .setName('Use the same answer for the rest of this deletion')
      .addToggle((toggle: ToggleComponent) => {
        toggle.setValue(false);
        toggle.onChange((value) => {
          this.shouldUseSameActionForRest = value;
        });
      });

    const buttonsEl = this.contentEl.createDiv({
      cls: 'advanced-rename-and-delete-handler rescue-ambiguity-buttons'
    });

    for (const notePath of this.survivingNotePaths) {
      const button = new ButtonComponent(buttonsEl);
      button.setButtonText(`Move to ${basename(notePath)}`);
      button.setTooltip(`Move the attachment into the attachment folder of ${notePath}`);
      button.onClick(() => {
        this.select(notePath);
      });
    }

    const leaveButton = new ButtonComponent(buttonsEl);
    leaveButton.setButtonText('Leave it here');
    leaveButton.onClick(() => {
      this.select(null);
    });

    invokeAsyncSafely(() => this.renderReferences(referencesEl));
  }

  /**
   * Lists the notes keeping the attachment alive as links the user can follow to deal with them.
   *
   * @param referencesEl - The element to render into.
   * @returns A {@link Promise} that resolves when the list is rendered.
   */
  private async renderReferences(referencesEl: HTMLElement): Promise<void> {
    referencesEl.createEl('p', { text: 'Still referenced by:' });
    const listEl = referencesEl.createEl('ul', {
      cls: 'advanced-rename-and-delete-handler rescue-ambiguity-notes'
    });

    for (const notePath of this.survivingNotePaths) {
      const itemEl = listEl.createEl('li');
      itemEl.append(
        await renderInternalLink({
          app: this.app,
          pathOrAbstractFile: notePath
        })
      );
    }
  }

  private select(adoptingNotePath: null | string): void {
    this.decision = {
      adoptingNotePath,
      shouldUseSameActionForRest: this.shouldUseSameActionForRest
    };
    this.close();
  }
}

/**
 * States why the priority list named no owner, in the user's terms rather than the enum's.
 *
 * @param reason - The reason reported by `findNoPriorityWinnerReason`.
 * @returns The sentence to show.
 */
export function getNoPriorityWinnerReasonText(reason: NoPriorityWinnerReason): string {
  switch (reason) {
    case NoPriorityWinnerReason.EmptyList: {
      return 'The Note priorities setting is empty, so nothing was configured to decide between these notes.';
    }

    case NoPriorityWinnerReason.NoMatch: {
      return 'None of these notes matches any entry in the Note priorities setting.';
    }

    case NoPriorityWinnerReason.Tie: {
      return 'Several of these notes tie for the best rank in the Note priorities setting, so it names no single owner.';
    }

    default: {
      return assertNever(reason);
    }
  }
}

/**
 * Asks which surviving note adopts an attachment the priority list could not place.
 *
 * @param params - The attachment, the notes keeping it alive, and why the list settled nothing.
 * @returns The user's answer. Dismissing the dialog leaves the attachment where it is.
 */
export async function showRescueAmbiguityModal(params: ShowRescueAmbiguityModalParams): Promise<RescueAmbiguityDecision> {
  return await showModal<RescueAmbiguityDecision>((promiseResolve) =>
    new RescueAmbiguityModal({
      ...params,
      promiseResolve
    })
  );
}
