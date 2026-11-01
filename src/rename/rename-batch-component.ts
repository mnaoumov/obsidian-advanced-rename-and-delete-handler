/**
 * @file
 *
 * Gathers the vault's renames into batches, for the follow-ups that run once a rename has settled.
 *
 * One move in the file explorer is many `rename` events: a folder fires one for itself and one for every file and
 * folder under it, and a handled note rename fires more for the attachments it moves. A follow-up that ran per
 * event would rewrite the same note once per moved file and could not see that a note and the image it embeds
 * moved together. So the events are collected until none has arrived for {@link RENAME_BATCH_DELAY_IN_MILLISECONDS},
 * and each handler sees the whole batch once.
 */

import type { App } from 'obsidian';

import { ComponentEx } from '@mnaoumov/obsidian-lib/components/component-ex';
import { invokeAsyncSafely } from '@mnaoumov/typescript-lib/async';

/**
 * How long the vault has to be free of renames before a batch is handed on.
 */
export const RENAME_BATCH_DELAY_IN_MILLISECONDS = 1000;

/**
 * A follow-up that runs once per batch of renames.
 *
 * @param renames - Old path to new path, for every file and folder the batch renamed. A path renamed twice in one
 * batch appears once, from its first path to its last.
 */
export type RenameBatchHandler = (this: void, renames: ReadonlyMap<string, string>) => Promise<void>;

interface RenameBatchComponentConstructorParams {
  readonly app: App;
  readonly handlers: readonly RenameBatchHandler[];
}

export class RenameBatchComponent extends ComponentEx {
  private readonly app: App;
  private readonly handlers: readonly RenameBatchHandler[];
  private pendingRenames = new Map<string, string>();
  private timeoutId: null | number = null;

  public constructor(params: RenameBatchComponentConstructorParams) {
    super();
    this.app = params.app;
    this.handlers = params.handlers;
  }

  public override onload(): void {
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.addRename(oldPath, file.path);
    }));
  }

  public override onunload(): void {
    this.clearTimer();
    this.pendingRenames = new Map();
  }

  private addRename(oldPath: string, newPath: string): void {
    const firstPath = [...this.pendingRenames].find(([, pendingNewPath]) => pendingNewPath === oldPath)?.[0] ?? oldPath;
    this.pendingRenames.set(firstPath, newPath);
    this.clearTimer();
    this.timeoutId = window.setTimeout(() => {
      this.timeoutId = null;
      invokeAsyncSafely(() => this.flush());
    }, RENAME_BATCH_DELAY_IN_MILLISECONDS);
  }

  private clearTimer(): void {
    if (this.timeoutId === null) {
      return;
    }

    window.clearTimeout(this.timeoutId);
    this.timeoutId = null;
  }

  private async flush(): Promise<void> {
    const renames = this.pendingRenames;
    this.pendingRenames = new Map();
    for (const handler of this.handlers) {
      try {
        await handler(renames);
      } catch (error) {
        console.error('A rename follow-up failed', error);
      }
    }
  }
}
