import type { App } from 'obsidian';
import type { PluginNoticeComponent } from 'obsidian-dev-utils/obsidian/components/plugin-notice-component';

import { GlobalCommandHandler } from 'obsidian-dev-utils/obsidian/command-handlers/global-command-handler';

import type { PluginSettingsComponent } from '../plugin-settings-component.ts';

import { deleteEmptyFolders } from '../delete-empty-folders.ts';

/**
 * Parameters for {@link DeleteEmptyFoldersCommandHandler}.
 */
export interface DeleteEmptyFoldersCommandHandlerConstructorParams {
  /**
   * Cancels the sweep — the plugin unloading, or the user aborting it.
   */
  readonly abortSignal: AbortSignal;

  /**
   * The application instance.
   */
  readonly app: App;

  /**
   * Shows the sweep's progress.
   */
  readonly pluginNoticeComponent: PluginNoticeComponent;

  /**
   * Where the empty-folder behavior and the include/exclude lists are read from, at invocation time
   * rather than at construction, so a setting changed since the command was registered is honoured.
   */
  readonly pluginSettingsComponent: PluginSettingsComponent;
}

/**
 * Sweeps the whole vault for empty folders on demand.
 *
 * The id, name and icon are the ones Consistent Attachments and Links used for the same command before it
 * moved here, so a user's existing hotkey and command-palette habit survive the move.
 */
export class DeleteEmptyFoldersCommandHandler extends GlobalCommandHandler {
  private readonly abortSignal: AbortSignal;
  private readonly app: App;
  private readonly pluginNoticeComponent: PluginNoticeComponent;
  private readonly pluginSettingsComponent: PluginSettingsComponent;

  public constructor(params: DeleteEmptyFoldersCommandHandlerConstructorParams) {
    super({
      icon: 'trash',
      id: 'delete-empty-folders',
      name: 'Delete empty folders'
    });

    this.abortSignal = params.abortSignal;
    this.app = params.app;
    this.pluginNoticeComponent = params.pluginNoticeComponent;
    this.pluginSettingsComponent = params.pluginSettingsComponent;
  }

  protected override async execute(): Promise<void> {
    const settings = this.pluginSettingsComponent.settings;
    await deleteEmptyFolders({
      abortSignal: this.abortSignal,
      app: this.app,
      emptyFolderBehavior: settings.emptyFolderBehavior,
      isPathIgnored: (path) => settings.isPathIgnored(path),
      pluginNoticeComponent: this.pluginNoticeComponent
    });
  }
}
