import { OpenDemoVaultCommandHandler } from 'obsidian-dev-utils/obsidian/command-handlers/open-demo-vault-command-handler';
import { PluginSettingsTabComponent } from 'obsidian-dev-utils/obsidian/components/plugin-settings-tab-component';
import { PluginDataHandler } from 'obsidian-dev-utils/obsidian/data-handler';
import { PluginBase } from 'obsidian-dev-utils/obsidian/plugin/plugin';
import { publishPluginApi } from 'obsidian-dev-utils/obsidian/plugin/plugin-api';
import { PluginEventSourceImpl } from 'obsidian-dev-utils/obsidian/plugin/plugin-event-source';

import type { InstalledConflict } from './conflicting-plugins.ts';
import type { AdvancedRenameAndDeleteHandlerApi } from './plugin-api.ts';
import type { RenameDeleteHandlerSettings } from './rename-delete-handler-component.ts';

import { DeleteEmptyFoldersCommandHandler } from './command-handlers/delete-empty-folders-command-handler.ts';
import { findInstalledConflicts } from './conflicting-plugins.ts';
import { PluginApiImpl } from './plugin-api-impl.ts';
import {
  PLUGIN_API_CONTRACT,
  PLUGIN_API_VERSION
} from './plugin-api.ts';
import { PluginSettingsComponent as PluginSettingsComponentImpl } from './plugin-settings-component.ts';
import { PluginSettingsTab } from './plugin-settings-tab.ts';
import { RenameDeleteHandlerComponent } from './rename-delete-handler-component.ts';
import { RescuePathResolver } from './rescue-path-resolver.ts';

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
      new PluginSettingsTabComponent({
        plugin: this,
        pluginSettingsTab: new PluginSettingsTab({
          plugin: this,
          pluginSettingsComponent
        })
      })
    );

    this.pluginApi = new PluginApiImpl({
      app: this.app,
      pluginSettingsComponent
    });
    publishPluginApi({
      api: this.pluginApi,
      apiVersion: PLUGIN_API_VERSION,
      contract: PLUGIN_API_CONTRACT,
      plugin: this
    });

    const rescuePathResolver = new RescuePathResolver({
      app: this.app,
      pluginSettingsComponent
    });

    this.addChild(
      new RenameDeleteHandlerComponent({
        abortSignalComponent: this.abortSignalComponent,
        app: this.app,
        pluginId: this.manifest.id,
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
