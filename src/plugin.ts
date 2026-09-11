import type {
  PluginConflict,
  PluginGateComponent
} from 'obsidian-dev-utils/obsidian/components/plugin-gate-component';
import type { PluginApiDeclaration } from 'obsidian-dev-utils/obsidian/plugin/plugin-api';

import { OpenDemoVaultCommandHandler } from 'obsidian-dev-utils/obsidian/command-handlers/open-demo-vault-command-handler';
import { PluginConflictSeverity } from 'obsidian-dev-utils/obsidian/components/plugin-gate-component';
import { PluginSettingsTabComponent } from 'obsidian-dev-utils/obsidian/components/plugin-settings-tab-component';
import { PluginDataHandler } from 'obsidian-dev-utils/obsidian/data-handler';
import { PluginBase } from 'obsidian-dev-utils/obsidian/plugin/plugin';
import { PluginEventSourceImpl } from 'obsidian-dev-utils/obsidian/plugin/plugin-event-source';

import type { InstalledConflict } from './conflicting-plugins.ts';
import type { AdvancedRenameAndDeleteHandlerApi } from './plugin-api.ts';
import type { RenameDeleteHandlerSettings } from './rename-delete-handler-component.ts';

import { DeleteEmptyFoldersCommandHandler } from './command-handlers/delete-empty-folders-command-handler.ts';
import { findInstalledConflicts } from './conflicting-plugins.ts';
import {
  CONSISTENT_ATTACHMENTS_AND_LINKS_DELETE_EMPTY_FOLDERS_VERSION_RANGE,
  CONSISTENT_ATTACHMENTS_AND_LINKS_PLUGIN_ID,
  CONSISTENT_ATTACHMENTS_AND_LINKS_PLUGIN_NAME
} from './consistent-attachments-and-links.ts';
import { FirstLoadNoticeComponent } from './first-load-notice-component.ts';
import { PluginApiImpl } from './plugin-api-impl.ts';
import {
  PLUGIN_API_CONTRACT,
  PLUGIN_API_VERSION
} from './plugin-api.ts';
import { PluginDependentsComponent } from './plugin-dependents-component.ts';
import { PluginSettingsComponent as PluginSettingsComponentImpl } from './plugin-settings-component.ts';
import { PluginSettingsTab } from './plugin-settings-tab.ts';
import { RenameDeleteHandlerComponent } from './rename-delete-handler-component.ts';
import { RescuePathResolver } from './rescue-path-resolver.ts';

const DELETE_EMPTY_FOLDERS_OVERLAP_REASON = 'Both plugins add a Delete empty folders command, so it appears'
  + ' twice in the command palette and running either copy sweeps the vault again.';

export class Plugin extends PluginBase {
  /**
   * This plugin's public API, or `null` before it has loaded — or when it refused to run because a
   * conflicting plugin is installed.
   *
   * The registry — `watchPluginApi` from `obsidian-dev-utils` — is the path a consumer should take: it
   * negotiates the contract version, waits out the load order and revokes the handle when this plugin
   * unloads. This field is the plain fallback for a consumer that cannot depend on a library version new
   * enough to have the registry.
   */
  public get api(): AdvancedRenameAndDeleteHandlerApi | null {
    return this.pluginApi;
  }

  private pluginApi: null | PluginApiImpl = null;

  /**
   * Declares the API for the base to publish, once `onloadImpl` has built it.
   *
   * Published by the base rather than by hand, so that the handle is revoked with the feature surface and
   * the `plugin-loaded` broadcast carries the contract version — which is what a plugin declaring this one
   * as a dependency waits for. Nothing is declared when the plugin refused to run.
   *
   * @returns The declaration, or none.
   */
  protected override getPluginApis(): PluginApiDeclaration[] {
    if (!this.pluginApi) {
      return [];
    }

    return [
      {
        api: this.pluginApi,
        apiVersion: PLUGIN_API_VERSION,
        contract: PLUGIN_API_CONTRACT
      }
    ];
  }

  protected override getPluginConflicts(): PluginConflict[] {
    return [
      {
        conflictingVersionRange: CONSISTENT_ATTACHMENTS_AND_LINKS_DELETE_EMPTY_FOLDERS_VERSION_RANGE,
        pluginId: CONSISTENT_ATTACHMENTS_AND_LINKS_PLUGIN_ID,
        pluginName: CONSISTENT_ATTACHMENTS_AND_LINKS_PLUGIN_NAME,
        reason: DELETE_EMPTY_FOLDERS_OVERLAP_REASON,
        severity: PluginConflictSeverity.Warn
      }
    ];
  }

  protected override async onloadImpl(): Promise<void> {
    /*
     * Before anything else, and before anything that awaits. A plugin that still owns a rename/delete
     * handler of its own would fight this one over every rename, so this plugin stands aside rather than
     * registering a second handler and hoping to win.
     */
    const conflicts = findInstalledConflicts(this.app);
    if (conflicts.length > 0) {
      await this.refuseToRun(conflicts);
      return;
    }

    const pluginSettingsComponent = this.addChild(
      new PluginSettingsComponentImpl({
        app: this.app,
        dataHandler: new PluginDataHandler(this),
        pluginEventSource: new PluginEventSourceImpl(this)
      })
    );
    this.pluginSettingsComponent = pluginSettingsComponent;

    this.addChild(
      new FirstLoadNoticeComponent({
        app: this.app,
        pluginId: this.manifest.id,
        pluginNoticeComponent: this.pluginNoticeComponent,
        pluginSettingsComponent
      })
    );

    // Subscribed here, before `getPluginApis()` publishes the API a dependent's gate waits for — so no
    // Dependent can finish loading, and announce it, before this is listening.
    const pluginDependentsComponent = this.addChild(
      new PluginDependentsComponent({
        app: this.app,
        pluginId: this.manifest.id
      })
    );

    this.addChild(
      new PluginSettingsTabComponent({
        plugin: this,
        pluginSettingsTab: new PluginSettingsTab({
          // Deliberately lazy: the gate is what loads this method, so the base has not assigned it yet.
          getPluginGateComponent: (): PluginGateComponent => this.pluginGateComponent,
          plugin: this,
          pluginDependentsComponent,
          pluginSettingsComponent
        })
      })
    );

    this.pluginApi = new PluginApiImpl({
      app: this.app,
      pluginSettingsComponent
    });

    const rescuePathResolver = new RescuePathResolver({
      app: this.app,
      pluginSettingsComponent
    });

    this.addChild(
      new RenameDeleteHandlerComponent({
        abortSignalComponent: this.abortSignalComponent,
        app: this.app,
        pluginNoticeComponent: this.pluginNoticeComponent,
        resourceLockComponent: this.resourceLockComponent,
        settingsBuilder: (): Partial<RenameDeleteHandlerSettings> => {
          const settings = pluginSettingsComponent.settings;
          return {
            emptyFolderBehavior: settings.emptyFolderBehavior,
            getRescuePath: async (params) => await rescuePathResolver.getRescuePath(params),
            isNote: (path: string): boolean => pluginSettingsComponent.isNoteEx(path),
            isPathIgnored: (path: string): boolean => settings.isPathIgnored(path),
            shouldDeleteConflictingAttachments: settings.shouldDeleteConflictingAttachments,
            shouldHandleDeletions: settings.shouldHandleDeletions,
            shouldHandleRenames: settings.shouldHandleRenames,
            shouldRenameAttachmentFiles: settings.shouldRenameAttachmentFiles,
            shouldRenameAttachmentFolder: settings.shouldRenameAttachmentFolder,
            shouldUpdateFileNameAliases: settings.shouldUpdateFileNameAliases
          };
        }
      })
    );

    await this.commandHandlerComponent.registerCommandHandlers(() => [
      new DeleteEmptyFoldersCommandHandler({
        abortSignal: this.abortSignalComponent.abortSignal,
        app: this.app,
        pluginNoticeComponent: this.pluginNoticeComponent,
        pluginSettingsComponent
      }),
      new OpenDemoVaultCommandHandler({
        app: this.app,
        pluginId: this.manifest.id,
        pluginNoticeComponent: this.pluginNoticeComponent,
        pluginVersion: this.manifest.version
      })
    ]);
  }

  /**
   * Reports the conflicting plugins and disables this one.
   *
   * `disablePlugin` rather than `disablePluginAndSave`: the plugin stays enabled in the vault's
   * configuration, so the next Obsidian start re-runs this check and the plugin comes back on its own
   * once the conflicts are updated. Saving the disabled state would make the user re-enable it by hand
   * after doing what the notice asked.
   *
   * @param conflicts - The conflicting plugins found installed.
   */
  private async refuseToRun(conflicts: readonly InstalledConflict[]): Promise<void> {
    const fragment = createFragment((f) => {
      f.appendText('Not running: these plugins still handle renames and deletes themselves, and two handlers would corrupt links.');
      const listEl = f.createEl('ul');
      for (const conflict of conflicts) {
        listEl.createEl('li', {
          text: `${conflict.plugin.name} ${conflict.installedVersion} — needs ${conflict.plugin.minSupportedVersion} or newer`
        });
      }
      f.appendText('Update them, or disable them, and this plugin starts on its own next time Obsidian opens.');
    });

    /*
     * Permanent, and therefore NOT `shouldHideOnClick: false`: that combination forces the separate mode,
     * which a permanent notice cannot use. Permanent already means it stays until replaced or dismissed.
     */
    this.pluginNoticeComponent.showNotice(fragment, { isPermanent: true });

    await this.app.plugins.disablePlugin(this.manifest.id);
  }
}
