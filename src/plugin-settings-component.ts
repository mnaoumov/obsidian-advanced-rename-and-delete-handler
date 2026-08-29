import type { App } from 'obsidian';
import type { DataHandler } from 'obsidian-dev-utils/obsidian/data-handler';
import type { PathOrAbstractFile } from 'obsidian-dev-utils/obsidian/file-system';
import type { PluginEventSource } from 'obsidian-dev-utils/obsidian/plugin/plugin-event-source';

import { PluginSettingsComponentBase } from 'obsidian-dev-utils/obsidian/components/plugin-settings-component';
import {
  getPath,
  isNote
} from 'obsidian-dev-utils/obsidian/file-system';

import { PluginSettings } from './plugin-settings.ts';

interface PluginSettingsComponentConstructorParams {
  readonly app: App;
  readonly dataHandler: DataHandler;
  readonly pluginEventSource: PluginEventSource;
}

export class PluginSettingsComponent extends PluginSettingsComponentBase<PluginSettings> {
  private readonly app: App;

  public constructor(params: PluginSettingsComponentConstructorParams) {
    super({
      dataHandler: params.dataHandler,
      pluginEventSource: params.pluginEventSource,
      pluginSettingsClass: PluginSettings
    });
    this.app = params.app;
  }

  /**
   * Whether the path is a note this plugin should treat as one.
   *
   * A file whose extension makes it a note is still an attachment when the user has listed its
   * extension in {@link PluginSettings.treatAsAttachmentExtensions} — `.excalidraw.md` being the case
   * that motivated the setting.
   *
   * @param pathOrFile - The path or file to test.
   * @returns `true` when the path is a note.
   */
  public isNoteEx(pathOrFile: null | PathOrAbstractFile): boolean {
    if (!pathOrFile || !isNote(pathOrFile)) {
      return false;
    }

    return !this.settings.isTreatedAsAttachment(getPath(this.app, pathOrFile));
  }
}
