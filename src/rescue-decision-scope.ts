/**
 * @file
 *
 * Makes sure one deletion asks the user about one attachment exactly once, and for exactly as long as
 * that answer is still about the deletion in hand.
 *
 * `getRescuePath` is asked TWICE about the same attachment when a folder is deleted, and — this is the
 * part that is easy to get wrong — the two asks OVERLAP. The replay deletes the owning note first, which
 * enqueues that note's own delete handler; the replay then reaches the attachment and awaits a dialog,
 * and while it is awaiting, the queue runs the handler it just produced, which walks the deleted note's
 * links back to the same attachment and asks again. Two dialogs open over one file, the user answers one,
 * and the deletion never finishes because the other is still waiting. Remembering finished answers cannot
 * help: at the moment the second ask arrives there is no finished answer to find. So the question itself
 * is what is shared — the second caller joins the first caller's pending promise.
 *
 * The window is one deletion, and nothing reports when a deletion cascade is over, so this counts what is
 * in flight instead of timing anything. Every deletion enters SYNCHRONOUSLY, as it is enqueued rather
 * than as it runs, which is what holds the count above zero across the gap between the replay finishing
 * and the queue starting on whatever it produced. Everything is dropped the moment the count reaches
 * zero, so the next, unrelated deletion asks afresh instead of inheriting a stale answer.
 */

/**
 * What the user answered, and how far the answer reaches.
 */
export interface RescueAnswer {
  /**
   * The answer itself.
   */
  readonly decision: RescueDecision;

  /**
   * Whether the answer also stands for the attachments still to come in this deletion.
   */
  readonly shouldUseSameActionForRest: boolean;
}

/**
 * An answer about where a stranded attachment should go.
 */
export interface RescueDecision {
  /**
   * The note that adopts the attachment, or `null` to leave the attachment where it is.
   */
  readonly adoptingNotePath: null | string;
}

/**
 * Parameters for {@link RescueDecisionScope.resolveDecision}.
 */
export interface RescueDecisionScopeResolveDecisionParams {
  /**
   * Puts the question to the user. Called at most once per attachment per deletion.
   *
   * @returns What the user answered.
   */
  ask(this: void): Promise<RescueAnswer>;

  /**
   * The attachment about to be stranded.
   */
  readonly attachmentPath: string;

  /**
   * The notes that still reference the attachment.
   */
  readonly survivingNotePaths: readonly string[];
}

type RescueDecisionScopeAskParams = RescueDecisionScopeResolveDecisionParams;

export class RescueDecisionScope {
  private readonly decisionsByAttachmentPath = new Map<string, RescueDecision>();
  private inFlightCount = 0;
  private readonly pendingDecisionsByAttachmentPath = new Map<string, Promise<RescueDecision>>();
  private stickyDecision: null | RescueDecision = null;

  /**
   * Registers a deletion as started. Must be called synchronously at the point the deletion is enqueued.
   */
  public enter(): void {
    this.inFlightCount++;
  }

  /**
   * Registers a deletion as finished, forgetting every answer once nothing is left in flight.
   */
  public exit(): void {
    this.inFlightCount--;

    if (this.inFlightCount > 0) {
      return;
    }

    /*
     * Clamped rather than trusted: an unbalanced exit must not drive the count negative, or the next
     * deletion's own exit would find it still below zero and never clear anything again.
     */
    this.inFlightCount = 0;
    this.decisionsByAttachmentPath.clear();
    this.stickyDecision = null;
  }

  /**
   * Answers where a stranded attachment should go, asking the user only if this deletion has not already
   * asked — or is not already asking — about that attachment.
   *
   * @param params - The attachment, its surviving notes, and how to put the question.
   * @returns The answer that governs this attachment.
   */
  public async resolveDecision(params: RescueDecisionScopeResolveDecisionParams): Promise<RescueDecision> {
    const settledDecision = this.findSettledDecision(params.attachmentPath, params.survivingNotePaths);
    if (settledDecision) {
      return settledDecision;
    }

    const pendingDecision = this.pendingDecisionsByAttachmentPath.get(params.attachmentPath);
    if (pendingDecision) {
      return await pendingDecision;
    }

    const decisionPromise = this.ask(params);
    this.pendingDecisionsByAttachmentPath.set(params.attachmentPath, decisionPromise);

    try {
      return await decisionPromise;
    } finally {
      /*
       * Dropped as soon as it settles, not held for the rest of the deletion: what a later caller should
       * find is the RECORDED answer, and a rejected question must not be handed on as if it were one.
       */
      this.pendingDecisionsByAttachmentPath.delete(params.attachmentPath);
    }
  }

  private async ask(params: RescueDecisionScopeAskParams): Promise<RescueDecision> {
    const answer = await params.ask();
    this.decisionsByAttachmentPath.set(params.attachmentPath, answer.decision);

    if (answer.shouldUseSameActionForRest) {
      this.stickyDecision = answer.decision;
    }

    return answer.decision;
  }

  /**
   * Finds the answer this deletion has already finished giving for the attachment.
   *
   * An answer the user asked to stand for the rest only applies while the note it names is one of the
   * survivors. The same tie does not necessarily repeat across a whole folder, and moving an attachment
   * into a note that does not reference it would be exactly the guess the dialog exists to avoid.
   *
   * @param attachmentPath - The attachment about to be stranded.
   * @param survivingNotePaths - The notes that still reference it.
   * @returns The answer to reuse, or `null` when there is none.
   */
  private findSettledDecision(attachmentPath: string, survivingNotePaths: readonly string[]): null | RescueDecision {
    const decision = this.decisionsByAttachmentPath.get(attachmentPath);
    if (decision) {
      return decision;
    }

    if (!this.stickyDecision) {
      return null;
    }

    const stickyNotePath = this.stickyDecision.adoptingNotePath;
    if (stickyNotePath !== null && !survivingNotePaths.includes(stickyNotePath)) {
      return null;
    }

    return this.stickyDecision;
  }
}
