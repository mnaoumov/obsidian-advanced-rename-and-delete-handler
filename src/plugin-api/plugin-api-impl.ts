/**
 * @file
 *
 * The implementation behind this plugin's public API.
 *
 * Kept apart from `plugin-api.ts` so that file stays a plain description of the contract a consumer reads,
 * with no runtime behavior in it.
 */

import type { App } from 'obsidian';

import { flushQueue } from '@mnaoumov/obsidian-lib/queue';
import { snapshot } from '@mnaoumov/typescript-lib/array';
import {
  noop,
  noopAsync
} from '@mnaoumov/typescript-lib/function';

import type { RenameDeleteHandlerComponent } from '../rename-delete-handler/rename-delete-handler-component.ts';
import type { PluginSettingsComponent } from '../settings/plugin-settings-component.ts';
import type {
  AdvancedRenameAndDeleteHandlerApi,
  BulkOperation,
  BulkOperationEvent,
  BulkOperationListener,
  HandedOverSettings,
  MigrateSettingsParams,
  MigrateSettingsResult,
  MoveManyParams
} from './plugin-api.ts';

import { showSettingsMigrationModal } from './settings-migration-modal.ts';
import {
  applyMigrationRows,
  buildSettingsMigrationRows
} from './settings-migration.ts';

/**
 * Parameters for constructing a {@link PluginApiImpl}.
 */
export interface PluginApiImplConstructorParams {
  /**
   * An Obsidian app instance.
   */
  readonly app: App;

  /**
   * The component owning this plugin's settings.
   */
  readonly pluginSettingsComponent: PluginSettingsComponent;

  /**
   * The component that handles renames and deletes, which carries out the bulk moves.
   */
  readonly renameDeleteHandlerComponent: Pick<RenameDeleteHandlerComponent, 'moveMany' | 'runInBatch'>;
}

/**
 * This plugin's API, as it is actually implemented.
 */
export class PluginApiImpl implements AdvancedRenameAndDeleteHandlerApi {
  private activeBulkOperation: BulkOperation | null = null;

  private readonly app: App;

  private readonly bulkOperationListeners = new Set<BulkOperationListener>();

  /**
   * Set while {@link moveMany} or {@link runInBatch} runs, from the call to the last rewrite. The component guards
   * only the stretches it has state for, and {@link moveMany}'s snapshot and rewrite are outside them.
   */
  private isBulkOperationRunning = false;

  private readonly pluginSettingsComponent: PluginSettingsComponent;
  /**
   * The tail of the dialog queue. Two consumers loading at once would otherwise stack two modals on top of
   * each other, and the second would compare against settings the first is about to change.
   */
  private queuedMigrations = noopAsync();

  private readonly renameDeleteHandlerComponent: Pick<RenameDeleteHandlerComponent, 'moveMany' | 'runInBatch'>;

  public constructor(params: PluginApiImplConstructorParams) {
    this.app = params.app;
    this.pluginSettingsComponent = params.pluginSettingsComponent;
    this.renameDeleteHandlerComponent = params.renameDeleteHandlerComponent;
  }

  /**
  Removes observers when the provider unloads.
  */
  public dispose(): void {
    this.bulkOperationListeners.clear();
  }

  /**
   * The settings this plugin holds right now, as plain data.
   *
   * @returns The current values.
   */
  public getSettings(): HandedOverSettings {
    const settings = this.pluginSettingsComponent.settings;
    return {
      emptyFolderBehavior: settings.emptyFolderBehavior,
      /*
       * Copies, not the arrays themselves: `excludePaths` and `includePaths` are getters onto the live
       * `PathSettings` arrays, so handing them over raw would let a consumer edit this plugin's settings by
       * pushing to what it was given. It is also what keeps the returned object plain data, which is all the
       * registry is willing to carry between two plugins' library copies.
       */
      excludePaths: [...settings.excludePaths],
      includePaths: [...settings.includePaths],
      notePriorities: [...settings.notePriorities],
      shouldDeleteConflictingAttachments: settings.shouldDeleteConflictingAttachments,
      shouldDeleteEmptyNoteFolders: settings.shouldDeleteEmptyNoteFolders,
      shouldHandleDeletions: settings.shouldHandleDeletions,
      shouldHandleRenames: settings.shouldHandleRenames,
      shouldRenameAttachmentFiles: settings.shouldRenameAttachmentFiles,
      shouldRenameAttachmentFolder: settings.shouldRenameAttachmentFolder,
      shouldRescueSharedAttachments: settings.shouldRescueSharedAttachments,
      shouldUpdateFileNameAliases: settings.shouldUpdateFileNameAliases,
      treatAsAttachmentExtensions: [...settings.treatAsAttachmentExtensions]
    };
  }

  /**
   * Whether this plugin leaves the path alone entirely, per its include and exclude lists.
   *
   * @param path - The path to test, from the vault root.
   * @returns `true` when the path is ignored.
   */
  public isPathIgnored(path: string): boolean {
    return this.pluginSettingsComponent.settings.isPathIgnored(path);
  }

  /**
   * Whether the path names an attachment even though its extension says otherwise, by an extension entry
   * or by a `property:` entry matching its frontmatter.
   *
   * @param path - The path to test, from the vault root.
   * @returns `true` when the path is treated as an attachment.
   */
  public isTreatedAsAttachment(path: string): boolean {
    return this.pluginSettingsComponent.isTreatedAsAttachment(path);
  }

  /**
   * Offers the user a set of settings values another plugin proposes, and applies what they approve.
   *
   * @param params - The proposal.
   * @returns What the user approved.
   */
  // eslint-disable-next-line typescript-dev-toolkit/params-options-name-match -- The type is the published contract's, shared with the interface this class implements; renaming it per class+method would rename it in every consumer.
  public async migrateSettings(migrateSettingsParams: MigrateSettingsParams): Promise<MigrateSettingsResult> {
    const previousMigrations = this.queuedMigrations;
    let releaseQueue: () => void = noop;
    this.queuedMigrations = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previousMigrations;

    try {
      return await this.migrateSettingsWithoutQueueing(migrateSettingsParams);
    } finally {
      releaseQueue();
    }
  }

  /**
   * Moves many files at once and rewrites each affected note once.
   *
   * @param moveManyParams - The moves.
   * @returns A {@link Promise} that resolves once the links are final.
   */
  // eslint-disable-next-line typescript-dev-toolkit/params-options-name-match -- The type is the published contract's, as for migrateSettings.
  public async moveMany(moveManyParams: MoveManyParams): Promise<void> {
    const plan = new Map<string, string>();
    const newPaths = new Set<string>();
    for (const { newPath, oldPath } of moveManyParams.moves) {
      // A `Map` would keep the last of two moves of one file without a word, and two moves to one path fail halfway.
      if (plan.has(oldPath)) {
        throw new Error(`Cannot move ${oldPath} twice.`);
      }
      if (newPaths.has(newPath)) {
        throw new Error(`Cannot move two files to ${newPath}.`);
      }
      plan.set(oldPath, newPath);
      newPaths.add(newPath);
    }

    await this.runBulkOperation('moveMany', async () => {
      await this.renameDeleteHandlerComponent.moveMany(plan);
    });
  }

  /**
   * Runs `operation`, which renames many files, and rewrites each note that links to them once, after all of them.
   *
   * @param operation - Performs the renames.
   * @returns A {@link Promise} that resolves once the links are final.
   */
  public async runInBatch(operation: () => Promise<void>): Promise<void> {
    await this.runBulkOperation('runInBatch', async () => {
      await this.renameDeleteHandlerComponent.runInBatch(operation);
    });
  }

  /**
   * Subscribes to the lifecycle of both bulk methods.
   *
   * @param listener - The synchronous observer.
   * @returns An idempotent unsubscribe function.
   */
  public subscribeBulkOperations(listener: BulkOperationListener): () => void {
    // Each registration is independent, even when the caller reuses the same function.
    function subscription(notification: BulkOperationEvent): Promise<void> | void {
      return listener(notification);
    }
    this.bulkOperationListeners.add(subscription);
    if (this.activeBulkOperation) {
      this.notifyBulkOperationListener(subscription, { isReplay: true, operation: this.activeBulkOperation, phase: 'start' });
    }
    return () => {
      this.bulkOperationListeners.delete(subscription);
    };
  }

  private getSourcePluginName(sourcePluginId: string): string {
    return this.app.plugins.manifests[sourcePluginId]?.name ?? sourcePluginId;
  }

  // eslint-disable-next-line typescript-dev-toolkit/params-options-name-match -- Same published contract type, one call deeper.
  private async migrateSettingsWithoutQueueing(migrateSettingsParams: MigrateSettingsParams): Promise<MigrateSettingsResult> {
    const rows = buildSettingsMigrationRows({
      currentSettings: this.pluginSettingsComponent.settings,
      proposedSettings: migrateSettingsParams.proposedSettings
    });

    /*
     * Nothing the proposal names differs from what this plugin already holds, so there is nothing to ask
     * about. The migration counts as done — the caller may record its one-shot flag.
     */
    if (rows.length === 0) {
      return { isApplied: true };
    }

    const approvedRows = await showSettingsMigrationModal({
      app: this.app,
      rows,
      sourcePluginName: this.getSourcePluginName(migrateSettingsParams.sourcePluginId)
    });

    if (!approvedRows) {
      return { isApplied: false };
    }

    await this.pluginSettingsComponent.editAndSave((settings) => {
      applyMigrationRows(settings, approvedRows);
    });

    return { isApplied: true };
  }

  private notifyBulkOperation(notification: BulkOperationEvent): void {
    for (const listener of snapshot(this.bulkOperationListeners)) {
      if (this.bulkOperationListeners.has(listener)) {
        this.notifyBulkOperationListener(listener, notification);
      }
    }
  }

  private notifyBulkOperationListener(listener: BulkOperationListener, notification: BulkOperationEvent): void {
    try {
      // Catch rejected promises too: TypeScript permits an async function where a void callback is expected.
      Promise.resolve(listener(Object.freeze(notification))).catch((error: unknown) => {
        console.error('Bulk operation observer failed.', error);
      });
    } catch (error) {
      console.error('Bulk operation observer failed.', error);
    }
  }

  private async runBulkOperation(kind: BulkOperation, operation: () => Promise<void>): Promise<void> {
    if (this.isBulkOperationRunning) {
      throw new Error('A bulk move is already running.');
    }

    this.isBulkOperationRunning = true;
    this.activeBulkOperation = kind;
    let isSuccessful = false;
    try {
      this.notifyBulkOperation({ operation: kind, phase: 'start' });
      await operation();
      isSuccessful = true;
    } finally {
      try {
        // A failed operation can still have handlers queued by renames it already completed.
        await flushQueue();
        await new Promise<void>((resolve) => {
          this.app.metadataCache.onCleanCache(resolve);
        });
      } finally {
        this.activeBulkOperation = null;
        // Keep the overlap guard through end callbacks so a callback cannot interleave a new batch's start.
        this.notifyBulkOperation({ isSuccessful, operation: kind, phase: 'end' });
        this.isBulkOperationRunning = false;
      }
    }
  }
}
