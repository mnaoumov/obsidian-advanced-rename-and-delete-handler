/**
 * @file
 *
 * Warns when a batch of renames leaves a path behind in the settings of Obsidian or another plugin.
 *
 * A templates folder, a daily notes folder or a plugin's watched folder is written down as a plain string, and
 * nothing tells its owner that the folder moved: Obsidian's link update covers links in notes only. So once a batch
 * has settled, every `.json` file in the config folder and every plugin's `data.json` is read and searched for the
 * old paths. The workspace files are skipped, because Obsidian rewrites them itself on its own schedule and a stale
 * path there is not a setting.
 *
 * It warns and does not fix (D1, 2026-11-01): a loaded plugin holds its settings in memory and writes them back on
 * its next save, so a rewrite under it is lost or races it, and reloading someone else's plugin is not a thing the
 * user asked for.
 */

import type { PluginNoticeComponent } from '@mnaoumov/obsidian-lib/components/plugin-notice-component';
import type { App } from 'obsidian';

import type { PluginSettingsComponent } from '../settings/plugin-settings-component.ts';
import type { RenamedPathHit } from './find-renamed-paths.ts';

import { findRenamedPaths } from './find-renamed-paths.ts';

/**
 * At most this many hits are listed in the notice; the rest are counted.
 */
export const MAX_LISTED_HITS = 10;

const SKIPPED_CONFIG_FILE_NAMES = new Set(['workspace-mobile.json', 'workspace.json']);

interface SettingsFile {
  readonly ownerName: string;
  readonly path: string;
}

interface SettingsFileHit extends RenamedPathHit {
  readonly ownerName: string;
}

interface SettingsPathWarnerConstructorParams {
  readonly app: App;
  readonly pluginNoticeComponent: PluginNoticeComponent;
  readonly pluginSettingsComponent: PluginSettingsComponent;
}

export class SettingsPathWarner {
  private readonly app: App;
  private readonly pluginNoticeComponent: PluginNoticeComponent;
  private readonly pluginSettingsComponent: PluginSettingsComponent;

  public constructor(params: SettingsPathWarnerConstructorParams) {
    this.app = params.app;
    this.pluginNoticeComponent = params.pluginNoticeComponent;
    this.pluginSettingsComponent = params.pluginSettingsComponent;
  }

  /**
   * Searches the settings files for the batch's old paths and shows one notice naming every hit, when
   * `shouldWarnAboutPathsInSettings` is on.
   *
   * @param renames - The batch, old path to new path, files and folders.
   */
  public async handleRenames(renames: ReadonlyMap<string, string>): Promise<void> {
    if (!this.pluginSettingsComponent.settings.shouldWarnAboutPathsInSettings || renames.size === 0) {
      return;
    }

    const hits: SettingsFileHit[] = [];
    for (const { ownerName, path } of await this.getSettingsFiles()) {
      const data = await this.readJson(path);
      hits.push(...findRenamedPaths(data, renames).map((hit) => ({ ...hit, ownerName })));
    }

    if (hits.length === 0) {
      return;
    }

    this.pluginNoticeComponent.showNotice(createFragment((f) => {
      f.appendText('Renamed paths are still named in settings. Update them there:');
      for (const hit of hits.slice(0, MAX_LISTED_HITS)) {
        f.createEl('br');
        f.appendText(`${hit.ownerName}: ${hit.keyPath === '' ? '' : `${hit.keyPath} = `}${hit.value} → ${hit.newPath}`);
      }

      if (hits.length <= MAX_LISTED_HITS) {
        return;
      }

      f.createEl('br');
      f.appendText(`…and ${String(hits.length - MAX_LISTED_HITS)} more.`);
    }));
  }

  private async getSettingsFiles(): Promise<SettingsFile[]> {
    const adapter = this.app.vault.adapter;
    const configDirectory = this.app.vault.configDir;
    const settingsFiles: SettingsFile[] = [];

    const configListing = await adapter.list(configDirectory);
    for (const path of configListing.files) {
      const fileName = path.slice(path.lastIndexOf('/') + 1);
      if (fileName.endsWith('.json') && !SKIPPED_CONFIG_FILE_NAMES.has(fileName)) {
        settingsFiles.push({ ownerName: `Obsidian (${fileName})`, path });
      }
    }

    const pluginsFolder = `${configDirectory}/plugins`;
    if (!await adapter.exists(pluginsFolder)) {
      return settingsFiles;
    }

    const pluginsListing = await adapter.list(pluginsFolder);
    for (const pluginFolder of pluginsListing.folders) {
      const dataPath = `${pluginFolder}/data.json`;
      if (!await adapter.exists(dataPath)) {
        continue;
      }

      const pluginFolderName = pluginFolder.slice(pluginFolder.lastIndexOf('/') + 1);
      const manifest = Object.values(this.app.plugins.manifests).find((candidate) => candidate.dir === pluginFolder);
      settingsFiles.push({ ownerName: manifest?.name ?? pluginFolderName, path: dataPath });
    }

    return settingsFiles;
  }

  private async readJson(path: string): Promise<unknown> {
    try {
      return JSON.parse(await this.app.vault.adapter.read(path));
    } catch {
      // A file that is half-written or not JSON at all holds no setting this can read.
      return null;
    }
  }
}
