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
  /**
   * Whether the first read of the settings found no `data.json` at all.
   *
   * The only trace a first run leaves: the library writes `data.json` only once a setting is saved, so a
   * vault with no file has never had this plugin's settings touched. That is a fresh install — or an upgrade
   * from a version whose defaults did things, by a user who never changed one, and whose behavior the
   * current no-op defaults just switched off. The two are indistinguishable from here, which is why the
   * answer is to tell both of them rather than to guess.
   *
   * @returns `true` when the first read found nothing, `false` once a file was there to read.
   */
  public get wasDataFileMissingOnInitialLoad(): boolean {
    return this._wasDataFileMissingOnInitialLoad;
  }

  private _wasDataFileMissingOnInitialLoad = false;

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
   * Leaves a `data.json` behind, so the next load no longer reads as a first run.
   *
   * `saveToFile` would write nothing here: it saves only what changed since the last read, and a first run has
   * changed nothing. An empty object is enough — the next load fills in every default and writes the complete
   * file itself. Written only while the file is still absent, so a save that got there first, such as an
   * approved migration, is never overwritten.
   */
  public async ensureDataFileExists(): Promise<void> {
    if (!isMissing(await this.dataHandler.loadData())) {
      return;
    }

    await this.dataHandler.saveData({});
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

  /**
   * Loads the settings, noting on the first load whether there was a `data.json` to load.
   *
   * The base reads the file itself and keeps no record of finding nothing, so the first load reads it once
   * more beforehand. A later reload — an external change to `data.json` — answers a different question and
   * is left alone.
   *
   * @param isInitialLoad - Whether the settings are being loaded for the first time.
   * @returns A {@link Promise} that resolves when the settings are loaded.
   */
  public override async loadFromFile(isInitialLoad: boolean): Promise<void> {
    if (isInitialLoad) {
      this._wasDataFileMissingOnInitialLoad = isMissing(await this.dataHandler.loadData());
    }

    await super.loadFromFile(isInitialLoad);
  }
}

/**
 * Whether a `loadData` result means there is no `data.json` — which is how the library itself reads it.
 *
 * @param data - What `loadData` returned.
 * @returns `true` when there is nothing stored.
 */
function isMissing(data: unknown): boolean {
  return data === undefined || data === null;
}
