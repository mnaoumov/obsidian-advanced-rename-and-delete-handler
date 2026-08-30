/**
 * @file
 *
 * The implementation behind this plugin's public API.
 *
 * Kept apart from `plugin-api.ts` so that file stays a plain description of the contract a consumer reads,
 * with no runtime behavior in it.
 */

import type { App } from 'obsidian';

import {
  noop,
  noopAsync
} from 'obsidian-dev-utils/function';

import type {
  AdvancedRenameAndDeleteHandlerApi,
  MigrateSettingsParams,
  MigrateSettingsResult
} from './plugin-api.ts';
import type { PluginSettingsComponent } from './plugin-settings-component.ts';

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
}

/**
 * This plugin's API, as it is actually implemented.
 */
export class PluginApiImpl implements AdvancedRenameAndDeleteHandlerApi {
  private readonly app: App;
  private readonly pluginSettingsComponent: PluginSettingsComponent;

  /**
   * The tail of the dialog queue. Two consumers loading at once would otherwise stack two modals on top of
   * each other, and the second would compare against settings the first is about to change.
   */
  private queuedMigrations = noopAsync();

  public constructor(params: PluginApiImplConstructorParams) {
    this.app = params.app;
    this.pluginSettingsComponent = params.pluginSettingsComponent;
  }

  /**
   * Offers the user a set of settings values another plugin proposes, and applies what they approve.
   *
   * @param params - The proposal.
   * @returns What the user approved.
   */
  // eslint-disable-next-line obsidian-dev-utils/params-options-name-match -- The type is the published contract's, shared with the interface this class implements; renaming it per class+method would rename it in every consumer.
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

  private getSourcePluginName(sourcePluginId: string): string {
    return this.app.plugins.manifests[sourcePluginId]?.name ?? sourcePluginId;
  }

  // eslint-disable-next-line obsidian-dev-utils/params-options-name-match -- Same published contract type, one call deeper.
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
}
