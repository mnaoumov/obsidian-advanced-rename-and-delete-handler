/**
 * @file
 *
 * Rewrites the HTML `src` and `href` paths a batch of renames broke.
 *
 * Obsidian resolves an `<img src>` like a link path — a bare name, `./x.png`, `/folder/x.png` and a full path all
 * find the file — but neither its metadata cache nor its link update knows such a value exists, so a rename leaves
 * every one of them pointing at nothing. The note text is the only source, and reading every note on every rename
 * would cost a full vault read each time. So the updater keeps the last path segment of every value per note,
 * refreshed only for notes whose size or modification time changed since it last looked. The first batch reads
 * every note once; later ones read only what changed. A note is opened for writing only when one of its values ends
 * in the name of a file the batch moved, or when the note moved itself.
 */

import type { PluginNoticeComponent } from '@mnaoumov/obsidian-lib/components/plugin-notice-component';
import type {
  App,
  TFile
} from 'obsidian';

import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';

import type { PluginSettingsComponent } from '../settings/plugin-settings-component.ts';

import { pluralize } from '../rename-delete-handler/pluralize.ts';
import {
  findHtmlPathReferences,
  splitHtmlPath
} from './html-path-references.ts';
import { rewriteHtmlPathReferences } from './html-path-rewriter.ts';

interface HtmlLinkUpdaterConstructorParams {
  readonly app: App;
  readonly pluginNoticeComponent: PluginNoticeComponent;
  readonly pluginSettingsComponent: PluginSettingsComponent;
}

interface IndexEntry {
  readonly lastSegments: ReadonlySet<string>;
  readonly mtime: number;
  readonly size: number;
}

export class HtmlLinkUpdater {
  private readonly app: App;
  private readonly index = new Map<string, IndexEntry>();
  private readonly pluginNoticeComponent: PluginNoticeComponent;
  private readonly pluginSettingsComponent: PluginSettingsComponent;

  public constructor(params: HtmlLinkUpdaterConstructorParams) {
    this.app = params.app;
    this.pluginNoticeComponent = params.pluginNoticeComponent;
    this.pluginSettingsComponent = params.pluginSettingsComponent;
  }

  /**
   * Rewrites what the batch broke, when `shouldUpdateHtmlLinks` is on.
   *
   * @param renames - The batch, old path to new path, files and folders.
   */
  public async handleRenames(renames: ReadonlyMap<string, string>): Promise<void> {
    const settings = this.pluginSettingsComponent.settings;
    if (!settings.shouldUpdateHtmlLinks) {
      return;
    }

    const fileRenames = new Map([...renames].filter(([, newPath]) => this.app.vault.getFileByPath(newPath) !== null));
    if (fileRenames.size === 0) {
      return;
    }

    const movedNames = new Set<string>();
    for (const oldPath of fileRenames.keys()) {
      this.index.delete(oldPath);
      const name = getLastSegment(oldPath);
      movedNames.add(name);
      if (name.endsWith('.md')) {
        movedNames.add(name.slice(0, -'.md'.length));
      }
    }

    const oldPathsByNewPath = new Map([...fileRenames].map(([oldPath, newPath]) => [newPath, oldPath]));
    let rewrittenCount = 0;
    let rewrittenFileCount = 0;

    for (const note of this.app.vault.getMarkdownFiles()) {
      if (settings.isPathIgnored(note.path)) {
        continue;
      }

      const lastSegments = await this.getLastSegments(note);
      const oldNotePath = oldPathsByNewPath.get(note.path);
      if (oldNotePath === undefined && [...lastSegments].every((segment) => !movedNames.has(segment))) {
        continue;
      }

      let noteRewrittenCount = 0;
      await this.app.vault.process(note, (content) => {
        const result = rewriteHtmlPathReferences(content, {
          existsNow: (path) => this.app.vault.getFileByPath(path) !== null,
          newNotePath: note.path,
          oldNotePath: oldNotePath ?? note.path,
          renames: fileRenames,
          resolveNow: (linkpath, sourcePath) => this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null,
          // The rewriter has just seen the file exist, in this same synchronous callback.
          shortestLinkpath: (targetPath, sourcePath, shouldKeepMdExtension) => this.app.metadataCache.fileToLinktext(ensureNonNullable(this.app.vault.getFileByPath(targetPath)), sourcePath, !shouldKeepMdExtension)
        });
        noteRewrittenCount = result.rewrittenCount;
        return result.content;
      });

      if (!(noteRewrittenCount > 0)) {
        continue;
      }

      rewrittenCount += noteRewrittenCount;
      rewrittenFileCount++;
    }

    if (rewrittenCount > 0 && settings.shouldShowLinkUpdateNotice) {
      this.pluginNoticeComponent.showNotice(`Updated ${pluralize(rewrittenCount, 'HTML link')} in ${pluralize(rewrittenFileCount, 'file')}.`);
    }
  }

  private async getLastSegments(note: TFile): Promise<ReadonlySet<string>> {
    const entry = this.index.get(note.path);
    if (entry?.mtime === note.stat.mtime && entry.size === note.stat.size) {
      return entry.lastSegments;
    }

    const content = await this.app.vault.cachedRead(note);
    const lastSegments = new Set(findHtmlPathReferences(content).map((reference) => getLastSegment(splitHtmlPath(reference.rawValue).decodedPath)));
    this.index.set(note.path, {
      lastSegments,
      mtime: note.stat.mtime,
      size: note.stat.size
    });
    return lastSegments;
  }
}

function getLastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase();
}
