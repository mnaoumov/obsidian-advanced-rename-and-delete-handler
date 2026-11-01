/**
 * @file
 *
 * Contains utility functions for handling rename and delete events in Obsidian.
 */

import type { AbortSignalComponent } from '@mnaoumov/obsidian-lib/components/abort-signal-component';
import type { PluginNoticeComponent } from '@mnaoumov/obsidian-lib/components/plugin-notice-component';
import type {
  EditBacklinksSnapshotParams,
  UpdateLinkParams,
  UpdateReferencesInFileParams
} from '@mnaoumov/obsidian-lib/link';
import type { LinkUpdateProgressReporter } from '@mnaoumov/obsidian-lib/link-update-progress';
import type { ResourceLockComponent } from '@mnaoumov/obsidian-lib/resource-lock';
import type { RescueStillUsedFileParams } from '@mnaoumov/obsidian-lib/vault-delete';
import type {
  LinkUpdate,
  LinkUpdatesHandler
} from '@obsidian-typings/obsidian-public-latest';
import type {
  App,
  CachedMetadata,
  Reference,
  TAbstractFile,
  TFile,
  TFolder
} from 'obsidian';

import {
  AttachmentPathContext,
  getAttachmentFilePath,
  getAttachmentFolderPath,
  hasOwnAttachmentFolder
} from '@mnaoumov/obsidian-lib/attachment-path';
import { rebasePathOntoFolder } from '@mnaoumov/obsidian-lib/attachment-unit-folder';
import { iterateReferencesAffectedByRename } from '@mnaoumov/obsidian-lib/backlink-index';
import { getCanvasReferences } from '@mnaoumov/obsidian-lib/canvas';
import { ComponentEx } from '@mnaoumov/obsidian-lib/components/component-ex';
import { MonkeyAroundComponent } from '@mnaoumov/obsidian-lib/components/monkey-around-component';
import { waitForPendingLinkUpdates } from '@mnaoumov/obsidian-lib/file-manager';
import {
  CANVAS_FILE_EXTENSION,
  getFile,
  getFileOrNull,
  getFolderOrNull,
  isCanvasFile,
  isFile,
  isFolder,
  isMarkdownFile,
  isNote
} from '@mnaoumov/obsidian-lib/file-system';
import {
  buildBacklinksSnapshot,
  editBacklinksSnapshot,
  editReferences,
  extractReferenceFile,
  splitSubpath,
  updateLink,
  updateReferencesInFile
} from '@mnaoumov/obsidian-lib/link';
import {
  getBacklinksForFileOrPath,
  getBacklinksForFileSafe,
  getReferences,
  hasBacklinkCachePlugin,
  registerFileCacheForNonExistingFile,
  registerFiles
} from '@mnaoumov/obsidian-lib/metadata-cache';
import { getObsidianLibState } from '@mnaoumov/obsidian-lib/obsidian-lib-state';
import {
  addToQueue,
  flushQueue
} from '@mnaoumov/obsidian-lib/queue';
import { isResourceLockedForPathByAncestor } from '@mnaoumov/obsidian-lib/resource-lock';
import {
  cleanupEmptyFolders,
  EmptyFolderBehavior,
  getSafeRenamePath,
  isChildOrSelf,
  renameSafe,
  trashSafe
} from '@mnaoumov/obsidian-lib/vault';
import { deleteIfNotUsed } from '@mnaoumov/obsidian-lib/vault-delete';
import { filterInPlace } from '@mnaoumov/typescript-lib/array';
import { getLibDebugger } from '@mnaoumov/typescript-lib/debug';
import { printError } from '@mnaoumov/typescript-lib/error';
import {
  normalizeOptionalProperties,
  toJson
} from '@mnaoumov/typescript-lib/object-utils';
import {
  basename,
  dirname,
  extname,
  join,
  relative
} from '@mnaoumov/typescript-lib/path';
/* v8 ignore start -- Deeply coupled to Obsidian runtime; requires running vault for meaningful testing. */
import {
  getDataAdapterEx,
  InternalPluginName
} from '@obsidian-typings/obsidian-public-latest/implementations';
import {
  FileManager,
  Vault
} from 'obsidian';

import type { UnitFolderMove } from '../rescue/unit-folder-rescue.ts';

import { RescueDecisionScope } from '../rescue/rescue-decision-scope.ts';
import { planUnitFolderMove } from '../rescue/unit-folder-rescue.ts';
import { pluralize } from './pluralize.ts';

/**
 * Parameters for {@link RenameDeleteHandlerSettings.getRescuePath}.
 */
export interface GetRescuePathParams {
  /**
   * The path of the attachment that is about to be stranded.
   */
  readonly attachmentPath: string;

  /**
   * The questions this deletion has already put to the user, and their answers.
   *
   * A consumer that asks the user anything must ask THROUGH this, because a folder deletion calls this
   * hook more than once for the same attachment and the calls overlap in time — see
   * {@link RescueDecisionScope}.
   */
  readonly rescueDecisionScope: RescueDecisionScope;

  /**
   * The paths of the notes that still reference the attachment once the deletion is done. Never empty.
   */
  readonly survivingNotePaths: readonly string[];
}

/**
 * Settings for the rename/delete handler.
 */
export interface RenameDeleteHandlerSettings {
  /**
   * A behavior of the rename/delete handler when deleting empty folders.
   */
  readonly emptyFolderBehavior: EmptyFolderBehavior;

  /**
   * Where to move an attachment that a deletion would otherwise strand — one that survives because another
   * note still references it, but is left sitting in a folder whose owning note is gone.
   *
   * Deciding the destination is the plugin's attachment-path policy, which is why the handler asks rather
   * than guesses. Returning `null` — or not implementing this at all — keeps the attachment where it is,
   * which is the behavior every consumer had before this member existed.
   */
  readonly getRescuePath?: (params: GetRescuePathParams) => Promise<null | RescueDestination>;

  /**
   * Whether the path is a note.
   */
  readonly isNote: (path: string) => boolean;

  /**
   * Whether to ignore the path. `isFolder` says the path is a folder, which only a folder-only glob (one ending in `/`) reads.
   */
  readonly isPathIgnored: (path: string, isFolder?: boolean) => boolean;

  /**
   * Whether to delete conflicting attachments.
   */
  readonly shouldDeleteConflictingAttachments: boolean;

  /**
   * Whether {@link emptyFolderBehavior} also applies to the folder a deleted note leaves empty. When off, only
   * the folders of the attachments the deletion removed are candidates.
   */
  readonly shouldDeleteEmptyNoteFolders: boolean;

  /**
   * Whether to handle deletions.
   */
  readonly shouldHandleDeletions: boolean;

  /**
   * Whether to handle renames.
   */
  readonly shouldHandleRenames: boolean;

  /**
   * Whether to rename attachment files when a note is renamed.
   */
  readonly shouldRenameAttachmentFiles: boolean;

  /**
   * Whether to rename attachment folder when a note is renamed.
   */
  readonly shouldRenameAttachmentFolder: boolean;

  /**
   * Whether to show the `Updated N links in M files.` notice after a rename updated links. Absent means shown.
   */
  readonly shouldShowLinkUpdateNotice: boolean;

  /**
   * Whether to update file name aliases when a note is renamed.
   */
  readonly shouldUpdateFileNameAliases: boolean;
}

/**
 * Where a stranded attachment belongs, as answered by {@link RenameDeleteHandlerSettings.getRescuePath}.
 */
export interface RescueDestination {
  /**
   * The path the attachment itself belongs at, when it travels alone.
   */
  readonly attachmentPath: string;

  /**
   * The folder the attachment has to travel inside, because the consuming plugin's user designated it as
   * an attachment unit — a `_files` tree, a drawing's sidecar folder. `null` when the attachment travels
   * alone, which is the answer a vault with no attachment-location plugin installed always gets.
   *
   * Moving the lone file out of such a folder tears the unit apart, so the folder is what the handler
   * moves; {@link RescueDestination.attachmentPath} still says where inside it the attachment lands.
   */
  readonly unitFolderPath: null | string;
}

interface DeleteHandlerConstructorParams {
  readonly abortSignal: AbortSignal;
  readonly app: App;
  readonly deletedMetadataCacheMap: Map<string, CachedMetadata>;
  readonly file: TAbstractFile;
  readonly pluginNoticeComponent: PluginNoticeComponent;
  readonly rescueDecisionScope: RescueDecisionScope;
  readonly settingsManager: SettingsManager;
}

interface DeleteProtectionPatchComponentConstructorParams {
  readonly app: App;
  readonly pluginNoticeComponent: PluginNoticeComponent;
  readonly rescueDecisionScope: RescueDecisionScope;
  readonly settingsManager: SettingsManager;
}

interface DidRescueStillUsedAttachmentParams {
  readonly app: App;
  readonly pluginNoticeComponent: PluginNoticeComponent;
  readonly rescueDecisionScope: RescueDecisionScope;
  readonly rescueParams: RescueStillUsedFileParams;
  readonly rootFolderPath: string;
  readonly settingsManager: SettingsManager;
}

interface EditRenameBacklinksParams {
  readonly abortSignal: AbortSignal;
  readonly app: App;
  readonly getNewTargetPath: (oldTargetPath: string) => string;
  readonly linkUpdateProgressReporter: LinkUpdateProgressReporter | null;
  readonly pluginNoticeComponent: PluginNoticeComponent;
  readonly resourceLockComponent: null | ResourceLockComponent;
  readonly shouldUpdateFileNameAliases: boolean | undefined;
  readonly snapshot: Map<string, Map<string, string>>;
}

interface FileManagerRunAsyncLinkUpdatePatchComponentConstructorParams {
  readonly app: App;
  readonly fileManager: FileManager;
  readonly settingsManager: SettingsManager;
}

interface FindSurvivingNotePathsParams {
  readonly app: App;
  readonly deletedNotePaths: Iterable<string>;
  readonly file: TFile;
}

interface HandledRenameKey {
  readonly newPath: string;
  readonly oldPath: string;
}

interface InterruptedRename {
  readonly combinedBacklinksMap: Map<string, Map<string, string>>;
  readonly oldPath: string;
}

interface MetadataDeletedHandlerConstructorParams {
  readonly deletedMetadataCacheMap: Map<string, CachedMetadata>;
  readonly file: TAbstractFile;
  readonly previousCache: CachedMetadata | null;
  readonly settingsManager: SettingsManager;
}

interface MoveUnitFolderParams {
  readonly app: App;
  readonly attachmentPath: string;
  readonly unitFolderMove: UnitFolderMove;
}

interface PendingRename {
  readonly file: TFile;
  readonly newPath: string;
}

interface RenameDeleteHandlerComponentConstructorParams {
  readonly abortSignalComponent: AbortSignalComponent;
  readonly app: App;
  readonly linkUpdateProgressReporter?: LinkUpdateProgressReporter;
  readonly pluginNoticeComponent: PluginNoticeComponent;
  readonly resourceLockComponent: null | ResourceLockComponent;
  readonly settingsBuilder: (this: void) => Partial<RenameDeleteHandlerSettings>;
}

interface RenameHandlerConstructorParams {
  readonly abortSignal: AbortSignal;
  readonly app: App;
  readonly backlinkBatch: BacklinkBatch | null;
  readonly handledRenames: HandledRenames;
  readonly interruptedCombinedBacklinksMap?: Map<string, Map<string, string>>;
  readonly interruptedRenamesMap: Map<string, InterruptedRename[]>;
  readonly linkUpdateProgressReporter: LinkUpdateProgressReporter | null;
  readonly newPath: string;
  readonly oldCache: CachedMetadata | null;
  readonly oldPath: string;
  readonly oldPathBacklinksMap: Map<string, Reference[]>;
  readonly pluginNoticeComponent: PluginNoticeComponent;
  readonly resourceLockComponent: null | ResourceLockComponent;
  readonly settingsManager: SettingsManager;
}

interface RenameMapConstructorParams {
  readonly abortSignal: AbortSignal;
  readonly app: App;
  readonly newPath: string;
  readonly oldCache: CachedMetadata | null;
  readonly oldPath: string;
  readonly settingsManager: SettingsManager;
}

interface RenameMapInitBacklinksMapParams {
  /**
   * The combined backlinks map, keyed by new backlink path, accumulating link-JSON to source-path mappings.
   */
  readonly combinedBacklinksMap: Map<string, Map<string, string>>;

  /**
   * The path whose backlinks are being recorded.
   */
  readonly path: string;

  /**
   * The backlinks map for a single file, keyed by backlink path.
   */
  readonly singleBacklinksMap: Map<string, Reference[]>;
}

interface RescueStillUsedUnitFoldersParams {
  readonly app: App;
  readonly deletedNotePaths: Iterable<string>;
  readonly pluginNoticeComponent: PluginNoticeComponent;
  readonly rescueDecisionScope: RescueDecisionScope;
  readonly rootFolder: TFolder;
  readonly settingsManager: SettingsManager;
  readonly shouldProtectIfStillUsed?: (this: void, file: TFile) => boolean;
}

/**
 * The backlink rewrites of a batch of renames, held back so that each linking note is rewritten once, after the
 * whole batch, instead of once per renamed file it links to. See {@link RenameDeleteHandlerComponent.runInBatch}.
 *
 * Every rename in the batch still moves its file and its attachments, and still rewrites the moved note's own
 * links, at once. Only the rewrites of OTHER notes' links wait. Until the flush those links point at paths that
 * no longer exist, so a batch that dies midway leaves them dangling.
 */
class BacklinkBatch {
  private readonly forwardPaths = new Map<string, string>();
  /**
   * Each file renamed during the batch, by its current path, with the path it had before the batch.
   */
  private readonly originalPaths = new Map<string, string>();
  private readonly snapshot = new Map<string, Map<string, string>>();

  /**
   * Holds back one rename's backlink snapshot: for each linking note, the link keys and the path each link
   * pointed at.
   *
   * @param combinedBacklinksMap - The snapshot {@link RenameHandler} would otherwise rewrite at once.
   */
  public add(combinedBacklinksMap: Map<string, Map<string, string>>): void {
    for (const [backlinkPath, linkKeyToPathMap] of combinedBacklinksMap) {
      let merged = this.snapshot.get(backlinkPath);
      if (!merged) {
        merged = new Map<string, string>();
        this.snapshot.set(backlinkPath, merged);
      }
      for (const [linkKey, oldTargetPath] of linkKeyToPathMap) {
        if (!merged.has(linkKey)) {
          merged.set(linkKey, oldTargetPath);
        }
      }
    }
  }

  /**
   * The files renamed during the batch.
   *
   * @returns Each one's current path and the path it had before the batch.
   */
  public getRenamedFiles(): MapIterator<[string, string]> {
    return this.originalPaths.entries();
  }

  /**
   * The held-back snapshot, its linking notes moved to where they are now.
   *
   * @returns The snapshot to rewrite.
   */
  public getResolvedSnapshot(): Map<string, Map<string, string>> {
    const resolved = new Map<string, Map<string, string>>();
    for (const [backlinkPath, linkKeyToPathMap] of this.snapshot) {
      const currentPath = this.resolve(backlinkPath);
      const merged = resolved.get(currentPath);
      if (!merged) {
        resolved.set(currentPath, linkKeyToPathMap);
        continue;
      }
      for (const [linkKey, oldTargetPath] of linkKeyToPathMap) {
        if (!merged.has(linkKey)) {
          merged.set(linkKey, oldTargetPath);
        }
      }
    }
    return resolved;
  }

  /**
   * Records a rename made during the batch, so that a path recorded before it can be followed to where the file
   * is now.
   *
   * @param oldPath - The path the file had.
   * @param newPath - The path it has now.
   */
  public recordRename(oldPath: string, newPath: string): void {
    this.forwardPaths.set(oldPath, newPath);
    const originalPath = this.originalPaths.get(oldPath) ?? oldPath;
    this.originalPaths.delete(oldPath);
    this.originalPaths.set(newPath, originalPath);
  }

  /**
   * Follows a path through the renames recorded during the batch. A path that a batch frees and then reuses for
   * another file would be followed wrongly; a batch must not do that.
   *
   * @param path - A path a file had at some point during the batch.
   * @returns The path that file has now.
   */
  public resolve(path: string): string {
    let current = path;
    const seen = new Set<string>();
    for (let next = this.forwardPaths.get(current); next !== undefined && !seen.has(next); next = this.forwardPaths.get(current)) {
      seen.add(current);
      current = next;
    }
    return current;
  }
}

class DeleteHandler {
  private readonly abortSignal: AbortSignal;
  private readonly app: App;
  private readonly deletedMetadataCacheMap: Map<string, CachedMetadata>;
  private readonly file: TAbstractFile;
  private readonly pluginNoticeComponent: PluginNoticeComponent;
  private readonly rescueDecisionScope: RescueDecisionScope;
  private readonly settingsManager: SettingsManager;

  public constructor(params: DeleteHandlerConstructorParams) {
    this.app = params.app;
    this.file = params.file;
    this.abortSignal = params.abortSignal;
    this.pluginNoticeComponent = params.pluginNoticeComponent;
    this.rescueDecisionScope = params.rescueDecisionScope;
    this.settingsManager = params.settingsManager;
    this.deletedMetadataCacheMap = params.deletedMetadataCacheMap;
  }

  public async handle(): Promise<void> {
    this.abortSignal.throwIfAborted();
    getLibDebugger('RenameDeleteHandler:handleDelete')(`Handle Delete ${this.file.path}`);
    if (!isNote(this.file)) {
      return;
    }

    if (await this.app.vault.adapter.exists(this.file.path)) {
      getLibDebugger('RenameDeleteHandler:handleDelete')(
        `Skipping delete handler of ${this.file.path} as the file still exists on disk (index-only removal, not a real deletion).`
      );
      return;
    }

    const settings = this.settingsManager.getSettings();

    if (settings.isPathIgnored?.(this.file.path, isFolder(this.file))) {
      getLibDebugger('RenameDeleteHandler:handleDelete')(`Skipping delete handler of ${this.file.path} as the path is ignored.`);
      return;
    }

    /*
     * The note's own folder is a candidate only on request: it is usually a folder the user made to file notes in,
     * which Obsidian never deletes with its last note either. A move already leaves a note's old folder alone.
     */
    const parentFolderPaths = new Set<string>(settings.shouldDeleteEmptyNoteFolders ? [dirname(this.file.path)] : []);

    if (settings.shouldHandleDeletions) {
      const cache = this.deletedMetadataCacheMap.get(this.file.path);
      this.deletedMetadataCacheMap.delete(this.file.path);
      if (cache) {
        const links = getReferences({ cache });

        for (const reference of links) {
          const attachmentFile = extractReferenceFile({ app: this.app, reference, sourcePathOrFile: this.file.path });
          if (!attachmentFile || this.settingsManager.isNoteEx(attachmentFile.path)) {
            continue;
          }

          parentFolderPaths.add(attachmentFile.parent?.path ?? '');
          await deleteIfNotUsed({
            app: this.app,
            deletedNotePath: this.file.path,
            pathOrFile: attachmentFile,
            pluginNoticeComponent: this.pluginNoticeComponent,
            /*
             * The vault root as the walked folder, because nothing is being walked: this deletes ONE named
             * attachment, so there is no folder whose deletion a unit-folder move could enlarge.
             */
            rescueStillUsedFile: this.rescueStillUsedFile.bind(this, ''),
            shouldDeleteEmptyFolders: settings.emptyFolderBehavior !== EmptyFolderBehavior.Keep
          });
          this.abortSignal.throwIfAborted();
        }
      }
    }

    parentFolderPaths.delete('');
    await cleanupEmptyFolders({
      app: this.app,
      emptyFolderBehavior: settings.emptyFolderBehavior ?? EmptyFolderBehavior.Keep,
      folderPaths: [...parentFolderPaths]
    });
    this.abortSignal.throwIfAborted();

    if (!settings.shouldHandleDeletions) {
      return;
    }

    const attachmentFolderPath = await getAttachmentFolderPath({
      app: this.app,
      context: AttachmentPathContext.DeleteNote,
      notePathOrFile: this.file.path
    });
    const attachmentFolder = getFolderOrNull({ app: this.app, pathOrFolder: attachmentFolderPath });

    if (
      !attachmentFolder || !await hasOwnAttachmentFolder({
        app: this.app,
        context: AttachmentPathContext.DeleteNote,
        path: this.file.path
      })
    ) {
      return;
    }

    this.abortSignal.throwIfAborted();

    /*
     * Before the walk, never during it — see `rescueStillUsedUnitFolders`.
     */
    await rescueStillUsedUnitFolders({
      app: this.app,
      deletedNotePaths: [this.file.path],
      pluginNoticeComponent: this.pluginNoticeComponent,
      rescueDecisionScope: this.rescueDecisionScope,
      rootFolder: attachmentFolder,
      settingsManager: this.settingsManager
    });
    this.abortSignal.throwIfAborted();

    await deleteIfNotUsed({
      app: this.app,
      deletedNotePath: this.file.path,
      pathOrFile: attachmentFolder,
      pluginNoticeComponent: this.pluginNoticeComponent,
      rescueStillUsedFile: this.rescueStillUsedFile.bind(this, attachmentFolder.path),
      shouldDeleteEmptyFolders: settings.emptyFolderBehavior !== EmptyFolderBehavior.Keep
    });
    this.abortSignal.throwIfAborted();
  }

  private rescueStillUsedFile(rootFolderPath: string, rescueParams: RescueStillUsedFileParams): Promise<boolean> {
    return didRescueStillUsedAttachment({
      app: this.app,
      pluginNoticeComponent: this.pluginNoticeComponent,
      rescueDecisionScope: this.rescueDecisionScope,
      rescueParams,
      rootFolderPath,
      settingsManager: this.settingsManager
    });
  }
}

/**
 * Keeps a folder deletion from destroying an attachment a note outside that folder still references.
 *
 * Deleting a NOTE is already safe: {@link deleteIfNotUsed} discounts the deleted note's own backlinks, sees
 * another note still referencing the attachment, and keeps it. Deleting a FOLDER was not, because
 * {@link RenameDeleteHandlerComponent} only listens (`vault.on('delete')`) and by the time a folder deletion
 * is reported its children are already gone. Nothing reactive can help, so this component intercepts the
 * deletion primitives instead: `FileManager.trashFile` (what the file-explorer Delete flow reaches through
 * `promptForDeletion`) plus the raw `Vault.delete` / `Vault.trash` a plugin may call directly.
 *
 * A folder deletion is scanned first. When nothing inside it is still referenced from outside — the
 * overwhelming majority of deletions — the original runs untouched, so the native behavior is preserved
 * exactly. Only when something would be lost does this take over, replaying the deletion through
 * {@link deleteIfNotUsed}: everything else in the folder goes, the still-referenced attachments and the
 * folders holding them stay, and the `attachmentIsStillUsed` notice fires, mirroring the note case.
 *
 * Files are never intercepted — deleting a file is the user naming that file explicitly.
 */
class DeleteProtectionPatchComponent extends MonkeyAroundComponent {
  private readonly app: App;
  private readonly pluginNoticeComponent: PluginNoticeComponent;

  /**
   * Roots of the folder deletions currently being replayed. The replay deletes through the UNPATCHED
   * original, so it cannot re-enter this component directly — but `FileManager.trashFile` itself calls down
   * into `Vault.trash` / `Vault.delete`, which are patched too, and re-scanning a subtree already being
   * walked is pure waste. Scoped by path rather than by a flag so that an unrelated folder deletion
   * interleaving on an `await` is still protected.
   */
  private readonly replayedFolderPaths = new Set<string>();

  private readonly rescueDecisionScope: RescueDecisionScope;

  private readonly settingsManager: SettingsManager;

  public constructor(params: DeleteProtectionPatchComponentConstructorParams) {
    super();
    this.app = params.app;
    this.pluginNoticeComponent = params.pluginNoticeComponent;
    this.rescueDecisionScope = params.rescueDecisionScope;
    this.settingsManager = params.settingsManager;
  }

  public override onload(): void {
    this.registerMethodPatch<FileManager, 'trashFile'>({
      $object: FileManager.prototype,
      methodName: 'trashFile',
      patchHandler: ({ fallback, originalArguments: [file], originalMethodBound }) =>
        this.handleDeletion(file, fallback, async (abstractFile) => {
          await originalMethodBound(abstractFile);
        })
    });
    this.registerMethodPatch<Vault, 'delete'>({
      $object: Vault.prototype,
      methodName: 'delete',
      patchHandler: ({ fallback, originalArguments: [file, force], originalMethodBound }) =>
        this.handleDeletion(file, fallback, async (abstractFile) => {
          await originalMethodBound(abstractFile, force);
        })
    });
    this.registerMethodPatch<Vault, 'trash'>({
      $object: Vault.prototype,
      methodName: 'trash',
      patchHandler: ({ fallback, originalArguments: [file, system], originalMethodBound }) =>
        this.handleDeletion(file, fallback, async (abstractFile) => {
          await originalMethodBound(abstractFile, system);
        })
    });
  }

  /**
   * Collects the paths of every note inside the folder. They are the link sources that disappear along with
   * the folder, so their backlinks must not keep an attachment alive.
   *
   * @param folder - The folder being deleted.
   * @param settings - The aggregated rename/delete handler settings.
   * @returns The paths of the notes inside the folder.
   */
  private collectDeletedNotePaths(folder: TFolder, settings: Partial<RenameDeleteHandlerSettings>): Set<string> {
    const deletedNotePaths = new Set<string>();
    Vault.recurseChildren(folder, (child) => {
      if (isFile(child) && (settings.isNote?.(child.path) ?? false)) {
        deletedNotePaths.add(child.path);
      }
    });
    return deletedNotePaths;
  }

  /**
   * Finds the attachments inside the folder that a note outside it still references, and would therefore be
   * destroyed by deleting the folder.
   *
   * @param folder - The folder being deleted.
   * @param deletedNotePaths - The paths of the notes that disappear along with the folder.
   * @param settings - The aggregated rename/delete handler settings.
   * @returns The paths of the attachments that must survive the deletion.
   */
  private async findStillUsedAttachmentPaths(
    folder: TFolder,
    deletedNotePaths: Set<string>,
    settings: Partial<RenameDeleteHandlerSettings>
  ): Promise<string[]> {
    const candidateFiles: TFile[] = [];
    Vault.recurseChildren(folder, (child) => {
      if (isFile(child) && !(settings.isNote?.(child.path) ?? false)) {
        candidateFiles.push(child);
      }
    });

    const stillUsedAttachmentPaths: string[] = [];

    for (const candidateFile of candidateFiles) {
      const survivingNotePaths = await findSurvivingNotePaths({
        app: this.app,
        deletedNotePaths,
        file: candidateFile
      });
      if (survivingNotePaths.length > 0) {
        stillUsedAttachmentPaths.push(candidateFile.path);
      }
    }

    return stillUsedAttachmentPaths;
  }

  /**
   * Decides whether a deletion needs protecting and, if so, replaces it with a protected replay.
   *
   * @param file - The abstract file being deleted.
   * @param fallback - Invokes the intercepted method unchanged.
   * @param deleteAbstractFile - Deletes a single abstract file through the intercepted method's unpatched original.
   * @returns A {@link Promise} that resolves when the deletion is done.
   */
  private handleDeletion(
    file: TAbstractFile,
    fallback: () => Promise<void>,
    deleteAbstractFile: (abstractFile: TAbstractFile) => Promise<void>
  ): Promise<void> {
    return this.shouldConsiderFolder(file) ? this.replayFolderDeletion(file, fallback, deleteAbstractFile) : fallback();
  }

  /**
   * Deletes the folder while keeping whatever inside it is still referenced from outside.
   *
   * @param folder - The folder being deleted.
   * @param fallback - Invokes the intercepted method unchanged.
   * @param deleteAbstractFile - Deletes a single abstract file through the intercepted method's unpatched original.
   * @returns A {@link Promise} that resolves when the deletion is done.
   */
  private async replayFolderDeletion(
    folder: TFolder,
    fallback: () => Promise<void>,
    deleteAbstractFile: (abstractFile: TAbstractFile) => Promise<void>
  ): Promise<void> {
    const settings = this.settingsManager.getSettings();
    const deletedNotePaths = this.collectDeletedNotePaths(folder, settings);
    const stillUsedAttachmentPaths = await this.findStillUsedAttachmentPaths(folder, deletedNotePaths, settings);

    if (stillUsedAttachmentPaths.length === 0) {
      getLibDebugger('RenameDeleteHandler:deleteProtection')(`Nothing to protect in ${folder.path}; deleting it as usual.`);
      await fallback();
      return;
    }

    getLibDebugger('RenameDeleteHandler:deleteProtection')(
      `Protecting ${stillUsedAttachmentPaths.length.toString()} still-referenced attachment(s) from the deletion of ${folder.path}: ${toJson(stillUsedAttachmentPaths)}`
    );

    this.replayedFolderPaths.add(folder.path);
    /*
     * Entered here rather than at the top of the method so the scope is only held open once the replay is
     * actually going to ask about something. The per-file handlers this replay's deletions trigger enter
     * the same scope as they are enqueued, which is what keeps it alive past the `finally` below.
     */
    this.rescueDecisionScope.enter();
    try {
      /*
       * Before the walk, never during it — see `rescueStillUsedUnitFolders`.
       */
      await rescueStillUsedUnitFolders({
        app: this.app,
        deletedNotePaths,
        pluginNoticeComponent: this.pluginNoticeComponent,
        rescueDecisionScope: this.rescueDecisionScope,
        rootFolder: folder,
        settingsManager: this.settingsManager,
        shouldProtectIfStillUsed: (candidateFile) => !(settings.isNote?.(candidateFile.path) ?? false)
      });

      await deleteIfNotUsed({
        app: this.app,
        deleteAbstractFile,
        deletedNotePaths: [...deletedNotePaths],
        pathOrFile: folder,
        pluginNoticeComponent: this.pluginNoticeComponent,
        rescueStillUsedFile: this.rescueStillUsedFile.bind(this, folder.path),
        /*
         * The user named THIS folder, so it goes even under `EmptyFolderBehavior.Keep` — that setting
         * governs folders emptied incidentally, not the one explicitly deleted. `deleteIfNotUsed` still
         * refuses to remove any folder whose child had to be kept, which is the protection wanted here.
         */
        shouldDeleteEmptyFolders: true,
        /*
         * A note that others link to is deleted as normal; Obsidian leaves the dangling link. Protecting
         * notes too would make deleting a folder of linked-to notes impossible.
         */
        shouldProtectIfStillUsed: (candidateFile) => !(settings.isNote?.(candidateFile.path) ?? false)
      });
    } finally {
      this.replayedFolderPaths.delete(folder.path);
      this.rescueDecisionScope.exit();
    }
  }

  private rescueStillUsedFile(rootFolderPath: string, rescueParams: RescueStillUsedFileParams): Promise<boolean> {
    return didRescueStillUsedAttachment({
      app: this.app,
      pluginNoticeComponent: this.pluginNoticeComponent,
      rescueDecisionScope: this.rescueDecisionScope,
      rescueParams,
      rootFolderPath,
      settingsManager: this.settingsManager
    });
  }

  /**
   * Checks whether a deletion is a folder deletion this handler is responsible for protecting.
   *
   * Every check here is synchronous and cheap, so a file deletion — the overwhelming majority — costs one
   * {@link isFolder} call and reaches the original untouched.
   *
   * @param file - The abstract file being deleted.
   * @returns `true` when the deletion should be scanned before it runs.
   */
  private shouldConsiderFolder(file: TAbstractFile): file is TFolder {
    if (!isFolder(file)) {
      return false;
    }

    const settings = this.settingsManager.getSettings();
    if (!settings.shouldHandleDeletions) {
      return false;
    }

    if (settings.isPathIgnored?.(file.path, true) ?? false) {
      return false;
    }

    for (const replayedFolderPath of this.replayedFolderPaths) {
      if (isChildOrSelf({ app: this.app, childPathOrFile: file.path, parentPathOrFile: replayedFolderPath })) {
        return false;
      }
    }

    return true;
  }
}

class FileManagerRunAsyncLinkUpdatePatchComponent extends MonkeyAroundComponent {
  /**
   * The rename whose `runAsyncLinkUpdate` snapshot is about to be taken: set when Obsidian's `onCleanCache`
   * callback for that snapshot fires, consumed by the very next `iterateAllRefs` call, which is the snapshot.
   */
  private activeSnapshotRename: null | PendingRename = null;
  private readonly app: App;
  private readonly fileManager: FileManager;
  private isForcingAlwaysUpdateLinks = false;
  /**
   * The rename `fileManager.renameFile` is performing, recorded for the `runAsyncLinkUpdate` call it makes
   * synchronously, which is the only one that cannot otherwise tell what is being renamed.
   */
  private pendingRename: null | PendingRename = null;
  private readonly settingsManager: SettingsManager;
  /**
   * The canvas link updates {@link wrapLinkUpdatesHandler} took out of a `linkUpdates` array, keyed by that array,
   * for the patched `updateAllLinks` to apply without Obsidian's *Update links* prompt.
   */
  private readonly unpromptedLinkUpdatesMap = new WeakMap<LinkUpdate[], LinkUpdate[]>();

  public constructor(params: FileManagerRunAsyncLinkUpdatePatchComponentConstructorParams) {
    super();
    this.app = params.app;
    this.fileManager = params.fileManager;
    this.settingsManager = params.settingsManager;
  }

  public override onload(): void {
    this.registerMethodPatch({
      $object: this.fileManager,
      methodName: 'runAsyncLinkUpdate',
      patchHandler: ({
        originalArguments: [linkUpdatesHandler],
        originalMethodBound
      }) => {
        const newHandler: LinkUpdatesHandler = (linkUpdates) => this.wrapLinkUpdatesHandler(linkUpdates, linkUpdatesHandler);
        const rename = this.pendingRename;
        this.pendingRename = null;
        // With `inProgressUpdates` set, Obsidian queues the handler onto the running update and takes no snapshot.
        return !rename || this.fileManager.inProgressUpdates
          ? originalMethodBound(newHandler)
          : this.withNarrowedSnapshot(rename, () => originalMethodBound(newHandler));
      }
    });

    this.registerMethodPatch({
      $object: this.fileManager,
      methodName: 'renameFile',
      patchHandler: ({
        originalArguments: [file, newPath],
        originalMethodBound
      }) => {
        if (!isFile(file)) {
          return originalMethodBound(file, newPath);
        }

        // `renameFile` calls `runAsyncLinkUpdate` synchronously, which picks this up and clears it.
        this.pendingRename = { file, newPath };
        try {
          return originalMethodBound(file, newPath);
        } finally {
          this.pendingRename = null;
        }
      }
    });

    this.registerMethodPatch({
      $object: this.app.metadataCache,
      methodName: 'iterateAllRefs',
      patchHandler: ({
        originalArguments: [callback],
        originalMethodBound
      }) => {
        const rename = this.activeSnapshotRename;
        if (!rename) {
          originalMethodBound(callback);
          return;
        }

        this.activeSnapshotRename = null;
        iterateReferencesAffectedByRename(this.app, rename.file, rename.newPath, callback);
      }
    });

    this.registerMethodPatch({
      $object: this.fileManager,
      methodName: 'updateAllLinks',
      patchHandler: async ({
        originalArguments: [linkUpdates],
        originalMethodBound
      }) => {
        await originalMethodBound(linkUpdates);
        const unpromptedLinkUpdates = this.unpromptedLinkUpdatesMap.get(linkUpdates);
        if (!unpromptedLinkUpdates) {
          return;
        }

        this.unpromptedLinkUpdatesMap.delete(linkUpdates);
        await this.updateAllLinksWithoutPrompt(unpromptedLinkUpdates, originalMethodBound);
      }
    });

    this.registerMethodPatch({
      $object: this.app.vault,
      methodName: 'getConfig',
      patchHandler: ({
        originalArguments: [configItem],
        originalMethodBound
      }) => {
        return (this.isForcingAlwaysUpdateLinks && configItem === 'alwaysUpdateLinks') || originalMethodBound(configItem);
      }
    });
  }

  /**
   * Runs Obsidian's native `updateAllLinks` on the canvas link updates this handler handed back, answering its
   * *Update links* prompt on the user's behalf.
   *
   * With `alwaysUpdateLinks` off (Obsidian's default), `updateAllLinks` does not update. It opens a confirmation
   * and awaits it, so a move this handler made, such as an attachment that a canvas embeds, asked about a file the
   * user never moved, and this plugin's serial queue waited behind the answer. With `shouldHandleRenames` on, the
   * handler already rewrites every other link without asking. The canvas entries go back to Obsidian only
   * because its canvas link updater is the one that edits a canvas correctly, so they get the same treatment.
   *
   * In the 1.14.2 bundle `updateAllLinks` reads the setting synchronously, before its first `await`, so it
   * answers `true` only while that synchronous part runs, and no other reader in the app sees the change. If a
   * later Obsidian moves the read past an `await`, the prompt returns. That is the behaviour before this fix, not
   * something worse.
   *
   * @param linkUpdates - The canvas link updates to apply.
   * @param updateAllLinks - Obsidian's native `updateAllLinks`, bound to the file manager.
   */
  private async updateAllLinksWithoutPrompt(linkUpdates: LinkUpdate[], updateAllLinks: (linkUpdates: LinkUpdate[]) => Promise<void>): Promise<void> {
    let updatePromise: Promise<void>;
    this.isForcingAlwaysUpdateLinks = true;
    try {
      updatePromise = updateAllLinks(linkUpdates);
    } finally {
      this.isForcingAlwaysUpdateLinks = false;
    }
    await updatePromise;
  }

  /**
   * Runs `runAsyncLinkUpdate` so that its snapshot of resolved references covers only the references the rename
   * can affect (`iterateReferencesAffectedByRename`) instead of every reference in the vault.
   *
   * Obsidian's `runAsyncLinkUpdate` queues a task on `fileManager.updateQueue`. The task waits for
   * `metadataCache.onCleanCache`, then calls `metadataCache.iterateAllRefs` once to take the snapshot, then runs the
   * handler that renames. The queued task is wrapped so that the `onCleanCache` callback it registers, and only
   * that one, arms the narrowing, which the `iterateAllRefs` patch consumes on the next call. Both temporary swaps
   * are undone synchronously, before anything else can call either method.
   *
   * @param rename - The rename being performed.
   * @param callOriginal - Calls Obsidian's `runAsyncLinkUpdate`.
   * @returns What `runAsyncLinkUpdate` returns.
   */
  private withNarrowedSnapshot(rename: PendingRename, callOriginal: () => Promise<void>): Promise<void> {
    const updateQueue = this.fileManager.updateQueue;
    const metadataCache = this.app.metadataCache;
    const originalQueue = Object.getOwnPropertyDescriptor(updateQueue, 'queue');
    const queue = updateQueue.queue.bind(updateQueue);

    updateQueue.queue = <T>(task: () => Promise<T> | T): Promise<T> =>
      queue(() => {
        const originalOnCleanCache = Object.getOwnPropertyDescriptor(metadataCache, 'onCleanCache');
        const onCleanCache = metadataCache.onCleanCache.bind(metadataCache);
        metadataCache.onCleanCache = (onCleanCacheCallback: () => void): void => {
          onCleanCache(() => {
            this.activeSnapshotRename = rename;
            onCleanCacheCallback();
          });
        };
        let result: Promise<T> | T;
        try {
          result = task();
        } finally {
          restoreProperty(metadataCache, 'onCleanCache', originalOnCleanCache);
        }
        return Promise.resolve(result).finally(() => {
          this.activeSnapshotRename = null;
        });
      });

    try {
      return callOriginal();
    } finally {
      restoreProperty(updateQueue, 'queue', originalQueue);
    }
  }

  /**
   * Suppresses Obsidian's own link update for the renames this handler has already rewritten, by emptying the
   * `linkUpdates` array that the native {@link FileManager.runAsyncLinkUpdate} collected.
   *
   * What that suppression does and does not save, read out of the Obsidian bundle - the shape is unchanged from
   * 1.12.7 through 1.13.7, and `obsidian-typings` declares none of it:
   *
   * - `runAsyncLinkUpdate` waits for a clean metadata cache and then walks EVERY reference in the vault
   *   (`metadataCache.iterateAllRefs`, one `getLinkpathDest` per reference) to build `linkUpdates` - before it
   *   calls this handler. For a `renameFile` of a file, {@link withNarrowedSnapshot} narrows that walk to the
   *   references the rename can affect; by the time this method is entered it has been paid either way, so
   *   nothing decided below can avoid it.
   * - `updateAllLinks(linkUpdates)`, which runs after this handler and is the only thing emptying the array
   *   skips, is linear in `linkUpdates.length`: one per-entry change computation, then a write for only the
   *   files whose link text actually changes, and an immediate return when none does.
   *
   * So a per-entry rollback below costs one change computation and at most one file write for the entry it
   * keeps, not a second vault scan. The three whole-call bail-outs pay that same per-entry cost across the
   * whole array, and the `!isRenameCalled` one writes nothing at all, because a reference whose target did not
   * move computes no change.
   *
   * Every exclusion below is therefore kept for the correctness reason its own comment gives, and none of them
   * is worth narrowing for speed.
   *
   * Nor can the walk be deferred by handing the handler a lazy `linkUpdates` that collects on first access. The
   * walk resolves every link against the vault as it stands BEFORE the handler runs, and every reader of the
   * array reads it AFTER the handler has changed the vault: this method's own bail-outs (so every rename under
   * the default `shouldHandleRenames: false`), `updateAllLinks`, and Obsidian's Note Composer merge, which
   * re-points the entries whose `resolvedFile` is the note it has just trashed. Collected that late, a link to
   * a renamed or trashed file no longer resolves, its entry is never made, and the link is left dangling.
   *
   * Narrowing that walk was first measured and refused (2026-09-24, Obsidian 1.14.2): it cost ~115 ms at 100k
   * references and ~320 ms at 250k, once per `renameFile`. A real 34k-file vault on Obsidian 1.15.0 (2026-10-31)
   * paid 5 s for a note and 38 s for a note with ten attachments, since every attachment this handler moves is
   * another `renameFile` and so another full walk, so the walk is now narrowed. It still runs in full, once, for
   * a folder `renameFile` and for every other caller of `runAsyncLinkUpdate`.
   *
   * @param linkUpdates - The link updates Obsidian collected before invoking the handler.
   * @param linkUpdatesHandler - The original handler passed to {@link FileManager.runAsyncLinkUpdate}.
   */
  private async wrapLinkUpdatesHandler(linkUpdates: LinkUpdate[], linkUpdatesHandler: LinkUpdatesHandler): Promise<void> {
    let isRenameCalled = false;
    let isForeignLockedRenameCalled = false;
    const eventRef = this.app.vault.on('rename', (file, oldPath) => {
      isRenameCalled = true;
      /*
       * A rename performed inside a foreign plugin's in-flight locked transaction (which locks the
       * affected folder subtree, e.g. `Advanced Note Composer`'s folder merge) is owned by that
       * transaction, which is responsible for its own link consistency. This handler deliberately does
       * NOT rewrite links for it, so suppressing Obsidian's native link update below would leave the
       * links dangling. Let the native update proceed untouched. See
       * https://github.com/mnaoumov/obsidian-advanced-note-composer/issues/146.
       */
      if (isResourceLockedForPathByAncestor(this.app, file.path) || isResourceLockedForPathByAncestor(this.app, oldPath)) {
        isForeignLockedRenameCalled = true;
      }
    });
    try {
      await linkUpdatesHandler(linkUpdates);
    } finally {
      this.app.vault.offref(eventRef);
    }
    const settings = this.settingsManager.getSettings();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- It might changed in `rename` event handler. ESLint mistakenly does not recognize it.
    if (!isRenameCalled || !settings.shouldHandleRenames || isForeignLockedRenameCalled) {
      return;
    }

    /*
     * A `runAsyncLinkUpdate` started while another is in progress hands its handler the SAME array, so a second
     * wrapper can reach an array the first one already recorded. Append to that record rather than replace it.
     */
    const unpromptedLinkUpdates = this.unpromptedLinkUpdatesMap.get(linkUpdates) ?? [];

    filterInPlace(
      linkUpdates,
      (linkUpdate) => {
        if (settings.isPathIgnored?.(linkUpdate.sourceFile.path)) {
          getLibDebugger('RenameDeleteHandler:runAsyncLinkUpdate')(
            `Roll back to default link update of source file ${linkUpdate.sourceFile.path} as the path is ignored.`
          );
          return true;
        }

        if (settings.isPathIgnored?.(linkUpdate.resolvedFile.path)) {
          getLibDebugger('RenameDeleteHandler:runAsyncLinkUpdate')(
            `Roll back to default link update of resolved file ${linkUpdate.resolvedFile.path} as the path is ignored.`
          );
          return true;
        }

        if (!this.app.internalPlugins.getEnabledPluginById(InternalPluginName.Canvas) || hasBacklinkCachePlugin(this.app)) {
          return false;
        }

        if (linkUpdate.sourceFile.extension === CANVAS_FILE_EXTENSION || linkUpdate.resolvedFile.extension === CANVAS_FILE_EXTENSION) {
          // Still Obsidian's to apply, but without its prompt: see `updateAllLinksWithoutPrompt`.
          unpromptedLinkUpdates.push(linkUpdate);
        }

        return false;
      }
    );

    if (unpromptedLinkUpdates.length > 0) {
      this.unpromptedLinkUpdatesMap.set(linkUpdates, unpromptedLinkUpdates);
    }
  }
}

class HandledRenames {
  private readonly map = new Map<string, HandledRenameKey>();

  public add(oldPath: string, newPath: string): void {
    this.map.set(this.keyToString(oldPath, newPath), { newPath, oldPath });
  }

  public delete(oldPath: string, newPath: string): void {
    this.map.delete(this.keyToString(oldPath, newPath));
  }

  public has(oldPath: string, newPath: string): boolean {
    return this.map.has(this.keyToString(oldPath, newPath));
  }

  public keys(): IterableIterator<HandledRenameKey> {
    return this.map.values();
  }

  private keyToString(oldPath: string, newPath: string): string {
    return `${oldPath} -> ${newPath}`;
  }
}

class MetadataDeletedHandler {
  private readonly deletedMetadataCacheMap: Map<string, CachedMetadata>;
  private readonly file: TAbstractFile;
  private readonly previousCache: CachedMetadata | null;
  private readonly settingsManager: SettingsManager;

  public constructor(params: MetadataDeletedHandlerConstructorParams) {
    this.deletedMetadataCacheMap = params.deletedMetadataCacheMap;
    this.file = params.file;
    this.previousCache = params.previousCache;
    this.settingsManager = params.settingsManager;
  }

  public handle(): void {
    const settings = this.settingsManager.getSettings();

    if (!settings.shouldHandleDeletions) {
      return;
    }

    if (settings.isPathIgnored?.(this.file.path, isFolder(this.file))) {
      getLibDebugger('RenameDeleteHandler:handleMetadataDeleted')(`Skipping metadata delete handler of ${this.file.path} as the path is ignored.`);
      return;
    }

    if (isMarkdownFile(this.file) && this.previousCache) {
      this.deletedMetadataCacheMap.set(this.file.path, this.previousCache);
    }
  }
}

class RenameHandler {
  private readonly abortSignal: AbortSignal;
  private readonly app: App;
  private readonly backlinkBatch: BacklinkBatch | null;
  private readonly handledRenames: HandledRenames;
  private readonly interruptedCombinedBacklinksMap: Map<string, Map<string, string>>;
  private readonly interruptedRenamesMap: Map<string, InterruptedRename[]>;
  private readonly linkUpdateProgressReporter: LinkUpdateProgressReporter | null;
  private readonly newPath: string;
  private readonly oldCache: CachedMetadata | null;
  private readonly oldPath: string;
  private readonly oldPathBacklinksMap: Map<string, Reference[]>;
  private readonly pluginNoticeComponent: PluginNoticeComponent;
  private readonly resourceLockComponent: null | ResourceLockComponent;
  private readonly settingsManager: SettingsManager;

  public constructor(params: RenameHandlerConstructorParams) {
    this.abortSignal = params.abortSignal;
    this.app = params.app;
    this.backlinkBatch = params.backlinkBatch;
    this.resourceLockComponent = params.resourceLockComponent;
    this.handledRenames = params.handledRenames;
    this.interruptedCombinedBacklinksMap = params.interruptedCombinedBacklinksMap ?? new Map<string, Map<string, string>>();
    this.interruptedRenamesMap = params.interruptedRenamesMap;
    this.linkUpdateProgressReporter = params.linkUpdateProgressReporter;
    this.newPath = params.newPath;
    this.oldCache = params.oldCache;
    this.oldPath = params.oldPath;
    this.oldPathBacklinksMap = params.oldPathBacklinksMap;
    this.pluginNoticeComponent = params.pluginNoticeComponent;
    this.settingsManager = params.settingsManager;
  }

  public async handle(): Promise<void> {
    if (this.oldPath === this.newPath) {
      return;
    }
    this.abortSignal.throwIfAborted();

    /*
     * The rename that triggered this handler is very likely still inside Obsidian's own
     * `FileManager.runAsyncLinkUpdate` cycle, which is about to decide — synchronously — which links to
     * rewrite, by re-resolving each one. Everything below temporarily registers a phantom file at the
     * old path (`registerFiles`, directly here and inside `RenameMap`) and holds it across an `await`;
     * seen mid-decision, that phantom makes the old path still resolve, so Obsidian concludes nothing
     * changed and rewrites nothing. Standing invariant: never touch the vault index while Obsidian is
     * mid-decision. See https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/47.
     */
    await waitForPendingLinkUpdates(this.app);
    this.abortSignal.throwIfAborted();

    await this.continueInterruptedRenames();
    this.abortSignal.throwIfAborted();

    // The refreshed backlinks feed `oldPathBacklinksMap`, which only the link-rewrite steps below read, and those are gated on the same flag.
    if (this.settingsManager.getSettings().shouldHandleRenames) {
      await this.refreshLinks();
      this.abortSignal.throwIfAborted();
    }

    if (await this.handleCaseCollision()) {
      return;
    }

    this.abortSignal.throwIfAborted();

    const pluginNoticeComponent = this.pluginNoticeComponent;

    const renamedFilePaths = getObsidianLibState('renamedFilePaths', new Set<string>()).value;
    const renamedLinks = getObsidianLibState('renamedLinkPaths', new Set<string>()).value;

    try {
      const renameMap = new RenameMap({
        abortSignal: this.abortSignal,
        app: this.app,
        newPath: this.newPath,
        oldCache: this.oldCache,
        oldPath: this.oldPath,
        settingsManager: this.settingsManager
      });
      await renameMap.fill();
      this.abortSignal.throwIfAborted();

      const settings = this.settingsManager.getSettings();

      const combinedBacklinksMap = new Map<string, Map<string, string>>();

      // Backlinks are only consumed by the link-rewrite steps below, which are gated on
      // `shouldHandleRenames`. Skip gathering them (a backlink fetch per attachment) on a move-only rename.
      if (settings.shouldHandleRenames) {
        renameMap.initOriginalLinksMap(combinedBacklinksMap);
        renameMap.initBacklinksMap({
          combinedBacklinksMap,
          path: this.oldPath,
          singleBacklinksMap: this.oldPathBacklinksMap
        });

        for (const attachmentOldPath of renameMap.keys()) {
          if (attachmentOldPath === this.oldPath) {
            continue;
          }
          const attachmentOldPathBacklinks = await getBacklinksForFileSafe({ app: this.app, pathOrFile: attachmentOldPath });
          const attachmentOldPathBacklinksMap = attachmentOldPathBacklinks.data;
          this.abortSignal.throwIfAborted();
          renameMap.initBacklinksMap({
            combinedBacklinksMap,
            path: attachmentOldPath,
            singleBacklinksMap: attachmentOldPathBacklinksMap
          });
        }
      }

      const parentFolderPaths = new Set<string>();

      for (const [oldAttachmentPath, newAttachmentPath] of renameMap.entries()) {
        if (oldAttachmentPath !== this.oldPath) {
          const fixedNewAttachmentPath = await this.renameHandled(oldAttachmentPath, newAttachmentPath);
          this.abortSignal.throwIfAborted();
          renameMap.set(oldAttachmentPath, fixedNewAttachmentPath);
        }
        if (!this.settingsManager.isNoteEx(oldAttachmentPath)) {
          parentFolderPaths.add(dirname(oldAttachmentPath));
        }
      }

      await cleanupEmptyFolders({
        app: this.app,
        emptyFolderBehavior: settings.emptyFolderBehavior ?? EmptyFolderBehavior.Keep,
        folderPaths: [...parentFolderPaths]
      });
      this.abortSignal.throwIfAborted();

      /*
       * The attachment move above runs regardless of `shouldHandleRenames` (that is the point of decoupling
       * "Move attachments with note" from "Update links"). The remaining steps only rewrite links, so skip
       * them when link updates are disabled; the `finally` block below still runs.
       */
      if (!settings.shouldHandleRenames) {
        return;
      }

      /*
       * A resumed rename brings its own snapshot along. Merge it INTO the current one rather than
       * concatenating the two: a file named by both would otherwise be opened and rewritten twice, which is
       * the very thing a combined snapshot exists to avoid. The current rename's entry wins a key collision,
       * because it describes where the target is now.
       */
      for (const [interruptedBacklinkPath, interruptedLinkKeyToPathMap] of this.interruptedCombinedBacklinksMap) {
        const linkKeyToPathMap = combinedBacklinksMap.get(interruptedBacklinkPath);
        if (!linkKeyToPathMap) {
          combinedBacklinksMap.set(interruptedBacklinkPath, interruptedLinkKeyToPathMap);
          continue;
        }

        for (const [linkKey, oldTargetPath] of interruptedLinkKeyToPathMap) {
          if (!linkKeyToPathMap.has(linkKey)) {
            linkKeyToPathMap.set(linkKey, oldTargetPath);
          }
        }
      }

      if (this.backlinkBatch) {
        this.backlinkBatch.add(combinedBacklinksMap);
      } else {
        await editRenameBacklinks({
          abortSignal: this.abortSignal,
          app: this.app,
          getNewTargetPath: (oldTargetPath) => renameMap.get(oldTargetPath) ?? oldTargetPath,
          linkUpdateProgressReporter: this.linkUpdateProgressReporter,
          pluginNoticeComponent,
          resourceLockComponent: this.resourceLockComponent,
          shouldUpdateFileNameAliases: settings.shouldUpdateFileNameAliases,
          snapshot: combinedBacklinksMap
        });
        this.abortSignal.throwIfAborted();
      }

      if (isNote(this.newPath)) {
        await updateReferencesInFile(normalizeOptionalProperties<UpdateReferencesInFileParams>({
          app: this.app,
          newSourcePathOrFile: this.newPath,
          oldSourcePathOrFile: this.oldPath,
          pluginNoticeComponent,
          resourceLockComponent: this.resourceLockComponent,
          shouldFailOnMissingFile: false,
          shouldUpdateFileNameAlias: settings.shouldUpdateFileNameAliases
        }));
        this.abortSignal.throwIfAborted();
      }

      if (!getFileOrNull({ app: this.app, pathOrFile: this.newPath })) {
        let interruptedRenames = this.interruptedRenamesMap.get(this.newPath);
        if (!interruptedRenames) {
          interruptedRenames = [];
          this.interruptedRenamesMap.set(this.newPath, interruptedRenames);
        }
        interruptedRenames.push({
          combinedBacklinksMap,
          oldPath: this.oldPath
        });
      }
    } finally {
      const orphanKeys = [...this.handledRenames.keys()];
      addToQueue({
        abortSignal: this.abortSignal,
        operationFunction: () => {
          for (const orphanKey of orphanKeys) {
            this.handledRenames.delete(orphanKey.oldPath, orphanKey.newPath);
          }

          if (renamedLinks.size === 0) {
            return;
          }
          // Read at drain time, so a toggle flipped mid-batch applies to the notice still pending. The counters
          // are cleared either way, or the next rename that does show a notice would report this one's links too.
          if (this.settingsManager.getSettings().shouldShowLinkUpdateNotice === false) {
            renamedFilePaths.clear();
            renamedLinks.clear();
            return;
          }
          pluginNoticeComponent.showNotice(`Updated ${pluralize(renamedLinks.size, 'link')} in ${pluralize(renamedFilePaths.size, 'file')}.`);
          renamedFilePaths.clear();
          renamedLinks.clear();
        },
        operationName: 'Handle orphaned renames'
      });
    }
  }

  private async continueInterruptedRenames(): Promise<void> {
    const interruptedRenames = this.interruptedRenamesMap.get(this.oldPath);
    if (!interruptedRenames) {
      return;
    }

    this.interruptedRenamesMap.delete(this.oldPath);
    for (const interruptedRename of interruptedRenames) {
      await new RenameHandler({
        abortSignal: this.abortSignal,
        app: this.app,
        backlinkBatch: this.backlinkBatch,
        handledRenames: this.handledRenames,
        interruptedCombinedBacklinksMap: interruptedRename.combinedBacklinksMap,
        interruptedRenamesMap: this.interruptedRenamesMap,
        linkUpdateProgressReporter: this.linkUpdateProgressReporter,
        newPath: this.newPath,
        oldCache: this.oldCache,
        oldPath: interruptedRename.oldPath,
        oldPathBacklinksMap: this.oldPathBacklinksMap,
        pluginNoticeComponent: this.pluginNoticeComponent,
        resourceLockComponent: this.resourceLockComponent,
        settingsManager: this.settingsManager
      }).handle();
    }
  }

  private async handleCaseCollision(): Promise<boolean> {
    if (!getDataAdapterEx(this.app).insensitive || this.oldPath.toLowerCase() !== this.newPath.toLowerCase()) {
      return false;
    }

    const temporaryPath = join(dirname(this.newPath), `__temp__${basename(this.newPath)}`);
    await this.renameHandled(this.newPath, temporaryPath);

    await new RenameHandler({
      abortSignal: this.abortSignal,
      app: this.app,
      backlinkBatch: this.backlinkBatch,
      handledRenames: this.handledRenames,
      interruptedRenamesMap: this.interruptedRenamesMap,
      linkUpdateProgressReporter: this.linkUpdateProgressReporter,
      newPath: temporaryPath,
      oldCache: this.oldCache,
      oldPath: this.oldPath,
      oldPathBacklinksMap: this.oldPathBacklinksMap,
      pluginNoticeComponent: this.pluginNoticeComponent,
      resourceLockComponent: this.resourceLockComponent,
      settingsManager: this.settingsManager
    }).handle();

    await this.app.fileManager.renameFile(getFile({ app: this.app, pathOrFile: temporaryPath }), this.newPath);
    return true;
  }

  private async refreshLinks(): Promise<void> {
    const fakeOldFile = getFile({ app: this.app, pathOrFile: this.oldPath, shouldIncludeNonExisting: true });
    let oldPathBacklinksMapRefreshed: Map<string, Reference[]>;
    {
      using _registration = registerFiles(this.app, [fakeOldFile]);
      const fakeOldFileBacklinks = await getBacklinksForFileSafe({ app: this.app, pathOrFile: fakeOldFile });
      oldPathBacklinksMapRefreshed = fakeOldFileBacklinks.data;
    }

    for (const [backlinkPath, refreshedLinks] of oldPathBacklinksMapRefreshed) {
      let oldLinks = this.oldPathBacklinksMap.get(backlinkPath);
      if (!oldLinks) {
        oldLinks = [];
        this.oldPathBacklinksMap.set(backlinkPath, oldLinks);
      }

      for (const link of refreshedLinks) {
        if (oldLinks.includes(link)) {
          continue;
        }
        oldLinks.push(link);
      }
    }
  }

  private async renameHandled(oldPath: string, newPath: string): Promise<string> {
    newPath = getSafeRenamePath({ app: this.app, newPath, oldPathOrAbstractFile: oldPath });
    if (oldPath === newPath) {
      return newPath;
    }
    this.handledRenames.add(oldPath, newPath);
    newPath = await renameSafe({ app: this.app, newPath, oldPathOrAbstractFile: oldPath });
    return newPath;
  }
}

class RenameMap {
  private readonly abortSignal: AbortSignal;
  private readonly app: App;
  private readonly map = new Map<string, string>();
  private readonly newPath: string;
  private readonly oldCache: CachedMetadata | null;
  private readonly oldPath: string;
  private readonly oldPathLinks: Reference[];
  private readonly settingsManager: SettingsManager;

  public constructor(params: RenameMapConstructorParams) {
    this.abortSignal = params.abortSignal;
    this.app = params.app;
    this.settingsManager = params.settingsManager;
    this.oldCache = params.oldCache;
    this.oldPath = params.oldPath;
    this.newPath = params.newPath;
    this.oldPathLinks = this.oldCache ? getReferences({ cache: this.oldCache }) : [];
  }

  public entries(): IterableIterator<[string, string]> {
    return this.map.entries();
  }

  public async fill(): Promise<void> {
    this.abortSignal.throwIfAborted();
    this.map.set(this.oldPath, this.newPath);

    if (!isNote(this.oldPath)) {
      return;
    }

    // Obsidian does not index a canvas file into the metadata cache.
    // The cache-derived `oldPathLinks` is empty for a canvas, hiding its embedded attachments.
    // Reading the canvas references directly moves them with the canvas (mirroring note behavior).
    // The file already lives at the new path after the rename, so read the references from there.
    if (isCanvasFile(this.oldPath)) {
      const canvasReferences = await getCanvasReferences(this.app, this.newPath);
      this.oldPathLinks.push(...canvasReferences);
    }

    const settings = this.settingsManager.getSettings();

    const oldFile = getFile({ app: this.app, pathOrFile: this.oldPath, shouldIncludeNonExisting: true });
    const oldAttachmentFolderPath = await this.getOldAttachmentFolderPath(oldFile);

    const newAttachmentFolderPath = settings.shouldRenameAttachmentFolder
      ? await getAttachmentFolderPath({
        app: this.app,
        context: AttachmentPathContext.RenameNote,
        notePathOrFile: this.newPath
      })
      : oldAttachmentFolderPath;

    const isOldAttachmentFolderAtRoot = oldAttachmentFolderPath === '/';

    const oldAttachmentFolder = getFolderOrNull({ app: this.app, pathOrFolder: oldAttachmentFolderPath });

    if (!oldAttachmentFolder) {
      return;
    }

    if (oldAttachmentFolderPath === newAttachmentFolderPath && !settings.shouldRenameAttachmentFiles) {
      return;
    }

    const oldAttachmentFiles: TFile[] = [];

    if (
      await hasOwnAttachmentFolder({
        app: this.app,
        context: AttachmentPathContext.RenameNote,
        path: this.oldPath
      })
    ) {
      Vault.recurseChildren(oldAttachmentFolder, (oldAttachmentFile) => {
        this.abortSignal.throwIfAborted();
        if (isFile(oldAttachmentFile)) {
          oldAttachmentFiles.push(oldAttachmentFile);
        }
      });
    } else {
      for (const oldPathLink of this.oldPathLinks) {
        this.abortSignal.throwIfAborted();
        const oldAttachmentFile = extractReferenceFile({ app: this.app, reference: oldPathLink, sourcePathOrFile: this.oldPath });
        if (!oldAttachmentFile) {
          continue;
        }

        if (!isOldAttachmentFolderAtRoot && !oldAttachmentFile.path.startsWith(oldAttachmentFolderPath)) {
          continue;
        }

        if (await this.canMoveLinkedAttachment(oldAttachmentFile, newAttachmentFolderPath)) {
          oldAttachmentFiles.push(oldAttachmentFile);
        }
      }
    }

    for (const oldAttachmentFile of oldAttachmentFiles) {
      this.abortSignal.throwIfAborted();
      if (this.settingsManager.isNoteEx(oldAttachmentFile.path)) {
        continue;
      }

      let newAttachmentFilePath: string;
      if (settings.shouldRenameAttachmentFiles) {
        newAttachmentFilePath = await getAttachmentFilePath({
          app: this.app,
          context: AttachmentPathContext.RenameNote,
          notePathOrFile: this.newPath,
          oldAttachmentPathOrFile: oldAttachmentFile,
          oldNotePathOrFile: this.oldPath,
          shouldSkipDuplicateCheck: true
        });
        this.abortSignal.throwIfAborted();
      } else {
        const relativePath = isOldAttachmentFolderAtRoot ? oldAttachmentFile.path : relative(oldAttachmentFolderPath, oldAttachmentFile.path);
        const newFolder = join(newAttachmentFolderPath, dirname(relativePath));
        newAttachmentFilePath = join(newFolder, oldAttachmentFile.name);
      }

      if (oldAttachmentFile.path === newAttachmentFilePath) {
        continue;
      }
      if (settings.shouldDeleteConflictingAttachments) {
        const newAttachmentFile = getFileOrNull({ app: this.app, pathOrFile: newAttachmentFilePath });
        if (newAttachmentFile) {
          getLibDebugger('RenameDeleteHandler:fillRenameMap')(`Removing conflicting attachment ${newAttachmentFile.path}.`);
          await trashSafe(this.app, newAttachmentFile);
          this.abortSignal.throwIfAborted();
        }
      } else {
        const directory = dirname(newAttachmentFilePath);
        const extension = extname(newAttachmentFilePath);
        const baseName = basename(newAttachmentFilePath, extension);
        newAttachmentFilePath = this.app.vault.getAvailablePath(join(directory, baseName), extension.slice(1));
      }
      this.map.set(oldAttachmentFile.path, newAttachmentFilePath);
    }
  }

  public get(oldPath: string): string | undefined {
    return this.map.get(oldPath);
  }

  public initBacklinksMap(params: RenameMapInitBacklinksMapParams): void {
    const {
      combinedBacklinksMap,
      path,
      singleBacklinksMap
    } = params;
    buildBacklinksSnapshot<string>({
      backlinks: singleBacklinksMap,
      pathRemapper: (backlinkPath) => this.map.get(backlinkPath) ?? backlinkPath,
      payloadProvider: () => path,
      referenceIdentityKeyProvider: getLinkIdentityKey,
      target: combinedBacklinksMap
    });
  }

  public initOriginalLinksMap(combinedBacklinksMap: Map<string, Map<string, string>>): void {
    for (const oldPathLink of this.oldPathLinks) {
      const oldAttachmentFile = extractReferenceFile({ app: this.app, reference: oldPathLink, sourcePathOrFile: this.oldPath });
      if (!oldAttachmentFile) {
        continue;
      }
      const backlinksMap = new Map<string, Reference[]>([[this.newPath, [oldPathLink]]]);
      this.initBacklinksMap({
        combinedBacklinksMap,
        path: oldAttachmentFile.path,
        singleBacklinksMap: backlinksMap
      });
    }
  }

  public keys(): IterableIterator<string> {
    return this.map.keys();
  }

  public set(oldPath: string, newPath: string): void {
    this.map.set(oldPath, newPath);
  }

  /**
   * Whether an attachment this note links moves with it.
   *
   * It does when no other note links it. It also does when every other note linking it already keeps its
   * attachments where this note is going to. A batch move is a run of single renames, each handled on its own,
   * and moving only an unshared attachment left a shared one behind for good: the first note saw the second
   * still in the old folder, and the last saw the first, already moved and still linking it. A linker that stays
   * behind resolves elsewhere and keeps the attachment where it is.
   *
   * The second rule is skipped when attachment files are renamed, because a renamed attachment takes its name
   * from the one note being moved, which for a shared attachment is just whichever note happened to move last.
   *
   * See https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/issues/5.
   *
   * @param attachmentFile - The attachment this note links.
   * @param newAttachmentFolderPath - The attachment folder this note resolves to at its new path.
   * @returns Whether the attachment moves with this note.
   */
  private async canMoveLinkedAttachment(attachmentFile: TFile, newAttachmentFolderPath: string): Promise<boolean> {
    const backlinks = await getBacklinksForFileSafe({ app: this.app, pathOrFile: attachmentFile });
    this.abortSignal.throwIfAborted();
    const linkerPaths = new Set<string>(backlinks.keys());
    linkerPaths.delete(this.oldPath);
    linkerPaths.delete(this.newPath);
    if (linkerPaths.size === 0) {
      return true;
    }

    if (this.settingsManager.getSettings().shouldRenameAttachmentFiles) {
      return false;
    }

    for (const linkerPath of linkerPaths) {
      const linkerAttachmentFolderPath = await getAttachmentFolderPath({
        app: this.app,
        context: AttachmentPathContext.RenameNote,
        notePathOrFile: linkerPath
      });
      this.abortSignal.throwIfAborted();
      if (linkerAttachmentFolderPath !== newAttachmentFolderPath) {
        return false;
      }
    }

    return true;
  }

  private async getOldAttachmentFolderPath(oldFile: TFile): Promise<string> {
    using _registration = registerFiles(this.app, [oldFile]);
    using _cacheRegistration = this.oldCache && oldFile.deleted
      ? registerFileCacheForNonExistingFile({ app: this.app, cache: this.oldCache, pathOrFile: oldFile })
      : undefined;
    return await getAttachmentFolderPath({
      app: this.app,
      context: AttachmentPathContext.RenameNote,
      notePathOrFile: this.oldPath
    });
  }
}

/**
 * Resolves the settings the handler runs with.
 *
 * There is exactly one contributor — this plugin — which is the whole point of the plugin existing. The
 * library's version of this code had to aggregate a registry of contributors and
 * OR-merge their answers, because every consumer plugin brought its own; here that registry is gone, and
 * so is any question of whose setting wins.
 *
 * What remains is defaulting: the builder returns a `Partial`, so the two predicates and the empty-folder
 * behavior need a value when it does not supply one.
 */
class SettingsManager {
  private readonly settingsBuilder: () => Partial<RenameDeleteHandlerSettings>;

  public constructor(settingsBuilder: () => Partial<RenameDeleteHandlerSettings>) {
    this.settingsBuilder = settingsBuilder;
  }

  public getSettings(): Partial<RenameDeleteHandlerSettings> {
    const builtSettings = this.settingsBuilder();
    return {
      ...builtSettings,
      emptyFolderBehavior: builtSettings.emptyFolderBehavior ?? EmptyFolderBehavior.Keep,
      isNote: (path: string): boolean => builtSettings.isNote?.(path) ?? isNote(path),
      isPathIgnored: (path: string, isFolderPath?: boolean): boolean => builtSettings.isPathIgnored?.(path, isFolderPath) ?? false
    };
  }

  public isNoteEx(path: string): boolean {
    const settings = this.getSettings();
    return settings.isNote?.(path) ?? false;
  }
}

/**
 * Component that handles rename and delete events in Obsidian.
 * It listens to rename and delete events and updates links accordingly.
 * It also handles edge cases such as case-only renames and collisions with existing files.
 */
export class RenameDeleteHandlerComponent extends ComponentEx {
  /**
   * The abort signal component whose signal cancels in-flight rename operations.
   */
  protected readonly abortSignalComponent: AbortSignalComponent;

  /**
   * The Obsidian app instance.
   */
  protected readonly app: App;
  /**
   * An optional reporter invoked once per backlink file whose links are updated during a rename/move,
   * with the running count of processed files and the total. When `null`, no progress is reported.
   */
  protected readonly linkUpdateProgressReporter: LinkUpdateProgressReporter | null;
  /**
   * The notice component used to report updated links to the user.
   */
  protected readonly pluginNoticeComponent: PluginNoticeComponent;
  /**
   * The resource lock component used to guard link updates, or `null` if none is used.
   */
  protected readonly resourceLockComponent: null | ResourceLockComponent;

  /**
   * Builds this plugin's rename/delete handler settings.
   */
  protected readonly settingsBuilder: () => Partial<RenameDeleteHandlerSettings>;

  /**
   * The manager that aggregates rename/delete handler settings across registered plugins.
   */
  protected readonly settingsManager: SettingsManager;

  private backlinkBatch: BacklinkBatch | null = null;

  private readonly deletedMetadataCacheMap = new Map<string, CachedMetadata>();

  private readonly handledRenames = new HandledRenames();

  private readonly interruptedRenamesMap = new Map<string, InterruptedRename[]>();

  private readonly rescueDecisionScope = new RescueDecisionScope();

  /**
   * Creates an instance of RenameDeleteHandlerComponent.
   *
   * @param params - The parameters for the RenameDeleteHandlerComponent.
   */
  public constructor(params: RenameDeleteHandlerComponentConstructorParams) {
    super();
    this.abortSignalComponent = params.abortSignalComponent;
    this.app = params.app;
    this.linkUpdateProgressReporter = params.linkUpdateProgressReporter ?? null;
    this.resourceLockComponent = params.resourceLockComponent;
    this.pluginNoticeComponent = params.pluginNoticeComponent;
    this.settingsBuilder = params.settingsBuilder;
    this.settingsManager = new SettingsManager(this.settingsBuilder);
  }

  /**
   * Loads the component
   */
  public override onload(): void {
    this.registerEvent(this.app.vault.on('delete', this.handleDelete.bind(this)));
    this.registerEvent(this.app.vault.on('rename', this.handleRename.bind(this)));
    this.registerEvent(this.app.metadataCache.on('deleted', this.handleMetadataDeleted.bind(this)));

    this.addChild(
      new FileManagerRunAsyncLinkUpdatePatchComponent({
        app: this.app,
        fileManager: this.app.fileManager,
        settingsManager: this.settingsManager
      })
    );

    this.addChild(
      new DeleteProtectionPatchComponent({
        app: this.app,
        pluginNoticeComponent: this.pluginNoticeComponent,
        rescueDecisionScope: this.rescueDecisionScope,
        settingsManager: this.settingsManager
      })
    );
  }

  /**
   * Runs `operation`, which renames many files, and rewrites each note that links to them once, after all of
   * them, instead of once per renamed file. Every rename still moves its file and attachments, and rewrites the
   * renamed note's own links, as it happens; only the rewrites of other notes' links are held back
   * ({@link BacklinkBatch}). A vault-wide move that touches a big list note hundreds of times touches it once.
   *
   * @param operation - Performs the renames. A rename must not reuse a path another rename in it frees.
   * @returns A {@link Promise} that resolves once every held-back link is rewritten.
   */
  public async runInBatch(operation: () => Promise<void>): Promise<void> {
    if (this.backlinkBatch) {
      throw new Error('A rename batch is already running.');
    }

    const backlinkBatch = new BacklinkBatch();
    this.backlinkBatch = backlinkBatch;
    try {
      await operation();
      // The batch's rename handlers are queued; each adds its snapshot to the batch when it runs.
      await flushQueue();
    } finally {
      this.backlinkBatch = null;
    }

    await editRenameBacklinks({
      abortSignal: this.abortSignalComponent.abortSignal,
      app: this.app,
      getNewTargetPath: (oldTargetPath) => backlinkBatch.resolve(oldTargetPath),
      linkUpdateProgressReporter: this.linkUpdateProgressReporter,
      pluginNoticeComponent: this.pluginNoticeComponent,
      resourceLockComponent: this.resourceLockComponent,
      shouldUpdateFileNameAliases: this.settingsManager.getSettings().shouldUpdateFileNameAliases,
      snapshot: backlinkBatch.getResolvedSnapshot()
    });

    /*
     * A renamed note's own links were rewritten when it moved, against the vault as it stood then. A link to a
     * file that moved LATER in the batch was missed both ways: it no longer resolved from the note's new folder
     * when the target moved, so it was not in the target's snapshot either. Resolve each still-dangling link from
     * where the note was before the batch, and follow the target through the batch's renames.
     */
    for (const [currentPath, originalPath] of backlinkBatch.getRenamedFiles()) {
      if (!isNote(currentPath) || !getFileOrNull({ app: this.app, pathOrFile: currentPath })) {
        continue;
      }
      await editReferences({
        app: this.app,
        pathOrFile: currentPath,
        pluginNoticeComponent: this.pluginNoticeComponent,
        referenceConverter: (reference) => {
          const { linkPath } = splitSubpath(reference.link);
          if (!linkPath || this.app.metadataCache.getFirstLinkpathDest(linkPath, currentPath)) {
            return;
          }
          const oldTargetPath = join(dirname(originalPath), linkPath);
          const newTargetPath = [backlinkBatch.resolve(oldTargetPath), backlinkBatch.resolve(`${oldTargetPath}.md`)]
            .find((path) => getFileOrNull({ app: this.app, pathOrFile: path }) !== null);
          if (!newTargetPath) {
            return;
          }
          return updateLink(normalizeOptionalProperties<UpdateLinkParams>({
            app: this.app,
            newSourcePathOrFile: currentPath,
            newTargetPathOrFile: newTargetPath,
            oldTargetPathOrFile: oldTargetPath,
            reference,
            shouldUpdateFileNameAlias: this.settingsManager.getSettings().shouldUpdateFileNameAliases
          }));
        },
        resourceLockComponent: this.resourceLockComponent
      });
    }
  }

  private handleDelete(file: TAbstractFile): void {
    /*
     * Entered synchronously, as the deletion is ENQUEUED rather than as it runs. A folder deletion is
     * replayed before these handlers are queued, and the replay's own scope closes as soon as it returns
     * — so entering here is what carries the user's answers across the gap to the handlers the replay
     * just produced. See `RescueDecisionScope`.
     */
    this.rescueDecisionScope.enter();

    addToQueue({
      operationFunction: async (abortSignal) => {
        try {
          await new DeleteHandler({
            abortSignal,
            app: this.app,
            deletedMetadataCacheMap: this.deletedMetadataCacheMap,
            file,
            pluginNoticeComponent: this.pluginNoticeComponent,
            rescueDecisionScope: this.rescueDecisionScope,
            settingsManager: this.settingsManager
          }).handle();
        } finally {
          /*
           * Reached even when the handler throws or aborts: the queue runs every item it accepted, and
           * an operation that failed still has to close the scope its enqueueing opened.
           */
          this.rescueDecisionScope.exit();
        }
      },
      operationName: `Handle delete: ${file.path}`
    });
  }

  private handleMetadataDeleted(file: TAbstractFile, previousCache: CachedMetadata | null): void {
    new MetadataDeletedHandler({
      deletedMetadataCacheMap: this.deletedMetadataCacheMap,
      file,
      previousCache,
      settingsManager: this.settingsManager
    }).handle();
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    this.backlinkBatch?.recordRename(oldPath, file.path);

    if (!isFile(file)) {
      return;
    }

    const newPath = file.path;

    getLibDebugger('RenameDeleteHandler:handleRename')(`Handle Rename ${oldPath} -> ${newPath}`);
    if (this.handledRenames.has(oldPath, newPath)) {
      this.handledRenames.delete(oldPath, newPath);
      return;
    }

    /*
     * A rename occurring inside a foreign plugin's in-flight locked transaction (which locks the
     * affected folder subtree, e.g. `Advanced Note Composer`'s folder merge) is orchestrated by that
     * transaction's owner, which takes responsibility for its own link consistency. Reacting to it
     * here would (a) perturb Obsidian's native post-rename link update and leave links dangling, and
     * (b) collide with the foreign transaction — an async abort from this handler aborts an
     * already-committed transaction, throwing "Cannot roll back a committed transaction". This
     * handler's own attachment moves are already excluded above via `handledRenames`, so a lock still
     * held here always belongs to a foreign operation; stay out of its way. See
     * https://github.com/mnaoumov/obsidian-advanced-note-composer/issues/146.
     */
    if (isResourceLockedForPathByAncestor(this.app, oldPath) || isResourceLockedForPathByAncestor(this.app, newPath)) {
      getLibDebugger('RenameDeleteHandler:handleRename')(
        `Skipping rename handler of ${oldPath} -> ${newPath} as it occurs inside a foreign locked transaction.`
      );
      return;
    }

    const settings = this.settingsManager.getSettings();
    if (!settings.shouldHandleRenames && !settings.shouldRenameAttachmentFolder && !settings.shouldRenameAttachmentFiles) {
      return;
    }

    if (this.isNoOpRename(settings, oldPath, newPath)) {
      getLibDebugger('RenameDeleteHandler:handleRename')(
        `Skipping rename handler of ${oldPath} -> ${newPath} as it is not a note and there is nothing to do with link updates disabled.`
      );
      return;
    }

    if (settings.isPathIgnored?.(oldPath)) {
      getLibDebugger('RenameDeleteHandler:handleRename')(`Skipping rename handler of old path ${oldPath} as the path is ignored.`);
      return;
    }

    if (settings.isPathIgnored?.(newPath)) {
      getLibDebugger('RenameDeleteHandler:handleRename')(`Skipping rename handler of new path ${newPath} as the path is ignored.`);
      return;
    }

    const oldCache = this.app.metadataCache.getCache(oldPath) ?? this.app.metadataCache.getCache(newPath);
    /*
     * Synchronous, inside the vault `rename` event, so a folder rename of F files runs F of these back to back
     * before anything yields. Obsidian's `getBacklinksForFile` would make each one a whole-vault walk that
     * resolves every reference; the index compares one hash per note and resolves only the references of the
     * notes that could link here.
     */
    const oldPathBacklinksMap = getBacklinksForFileOrPath(this.app, oldPath).data;
    addToQueue({
      abortSignal: this.abortSignalComponent.abortSignal,
      operationFunction: (abortSignal) =>
        new RenameHandler({
          abortSignal,
          app: this.app,
          backlinkBatch: this.backlinkBatch,
          handledRenames: this.handledRenames,
          interruptedRenamesMap: this.interruptedRenamesMap,
          linkUpdateProgressReporter: this.linkUpdateProgressReporter,
          newPath,
          oldCache,
          oldPath,
          oldPathBacklinksMap,
          pluginNoticeComponent: this.pluginNoticeComponent,
          resourceLockComponent: this.resourceLockComponent,
          settingsManager: this.settingsManager
        }).handle(),
      operationName: `Handle rename: ${oldPath} -> ${newPath}`
    });
  }

  /**
   * With link rewriting off, the handler's only remaining jobs are moving a NOTE's attachments and pruning
   * the folder a moved file vacated. A non-note rename needs neither when empty folders are kept, so there
   * is nothing to queue.
   *
   * @param settings - The aggregated rename/delete handler settings.
   * @param oldPath - The path the file was renamed from.
   * @param newPath - The path the file was renamed to.
   * @returns `true` when the handler would do no work for this rename.
   */
  private isNoOpRename(settings: Partial<RenameDeleteHandlerSettings>, oldPath: string, newPath: string): boolean {
    return !settings.shouldHandleRenames
      && !(settings.isNote?.(oldPath) ?? false)
      && !(settings.isNote?.(newPath) ?? false)
      && (settings.emptyFolderBehavior ?? EmptyFolderBehavior.Keep) === EmptyFolderBehavior.Keep;
  }
}

/**
 * Moves an attachment a deletion would otherwise strand to wherever the consuming plugin says it belongs.
 *
 * Shared by both delete paths — the note delete in {@link DeleteHandler} and the folder delete replayed by
 * {@link DeleteProtectionPatchComponent} — because both reach the same point: {@link deleteIfNotUsed} has
 * decided the attachment must survive, and without this it would survive in a folder nothing owns any more.
 *
 * A consumer that does not implement {@link RenameDeleteHandlerSettings.getRescuePath}, or that answers
 * `null`, gets exactly the behavior it had before this existed: the attachment stays put.
 *
 * @param params - The parameters for the function.
 * @returns A {@link Promise} that resolves to whether the attachment was moved.
 */
async function didRescueStillUsedAttachment(params: DidRescueStillUsedAttachmentParams): Promise<boolean> {
  const settings = params.settingsManager.getSettings();
  if (!settings.getRescuePath) {
    return false;
  }

  const attachmentPath = params.rescueParams.file.path;
  const rescueDestination = await settings.getRescuePath({
    attachmentPath,
    rescueDecisionScope: params.rescueDecisionScope,
    survivingNotePaths: params.rescueParams.survivingNotePaths
  });

  if (rescueDestination === null) {
    getLibDebugger('RenameDeleteHandler:didRescueStillUsedAttachment')(`No rescue path for ${attachmentPath}; keeping it where it is.`);
    return false;
  }

  const unitFolderMove = planUnitFolderMove({
    rescueDestination,
    rootFolderPath: params.rootFolderPath
  });

  if (rescueDestination.unitFolderPath !== null && !unitFolderMove) {
    /*
     * The attachment is one file of a folder that has to travel whole, and that folder is not going
     * anywhere — it already sits at its destination, or it is the very folder being deleted. Moving the
     * lone file out would split the unit, which is exactly the damage this understands how to avoid, so
     * the attachment is kept where it is instead.
     */
    getLibDebugger('RenameDeleteHandler:didRescueStillUsedAttachment')(
      `${attachmentPath} belongs to the attachment unit folder ${rescueDestination.unitFolderPath}, which cannot move; keeping it where it is.`
    );
    return false;
  }

  try {
    /*
     * An attachment designated as part of a unit travels as the whole folder. Moving the lone file would
     * leave its siblings behind and the unit arrives broken — the defect this branch exists to fix.
     *
     * `renameSafe` creates the destination folder, resolves a collision via `getSafeRenamePath`, and moves
     * through `app.fileManager.renameFile`, so the surviving notes' links follow the attachment either way.
     */
    const newAttachmentPath = unitFolderMove
      ? await moveUnitFolder({
        app: params.app,
        attachmentPath,
        unitFolderMove
      })
      : await renameSafe({
        app: params.app,
        newPath: rescueDestination.attachmentPath,
        oldPathOrAbstractFile: params.rescueParams.file
      });

    if (newAttachmentPath === null || newAttachmentPath === attachmentPath) {
      /*
       * The attachment is already where it belongs — or its unit folder could not be resolved. The former
       * is the normal second look at a file the folder delete just rescued: the owning note's own deletion
       * is reported afterwards and walks its links again. Nothing moved, so nothing is claimed — the caller
       * keeps it in place, which is the truth.
       */
      getLibDebugger('RenameDeleteHandler:didRescueStillUsedAttachment')(`${attachmentPath} already sits at its rescue path; nothing to move.`);
      return false;
    }

    /*
     * The move fires `vault.on('rename')`, so this handler's own `RenameHandler` picks it up like any other
     * attachment move. It is deliberately NOT registered in `handledRenames`:
     * `FileManagerRunAsyncLinkUpdatePatchComponent` already discards Obsidian's native link update while
     * `shouldHandleRenames` is on, so suppressing the handler as well would leave dangling exactly the links
     * this rescue exists to preserve. Let the rewrite settle before the delete walk carries on.
     */
    await waitForPendingLinkUpdates(params.app);

    getLibDebugger('RenameDeleteHandler:didRescueStillUsedAttachment')(`Rescued ${attachmentPath} to ${newAttachmentPath}.`);
    params.pluginNoticeComponent.showNotice(`Attachment ${attachmentPath} is still used by other notes. It was moved to ${newAttachmentPath}.`);
    return true;
  } catch (error) {
    /*
     * A rescue that half happened must not read as success — reporting `false` falls back to keeping the
     * attachment in place with the `attachmentIsStillUsed` notice, which is still safe.
     */
    printError(new Error(`Failed to rescue ${attachmentPath} to ${unitFolderMove?.newFolderPath ?? rescueDestination.attachmentPath}`, { cause: error }));
    return false;
  }
}

/**
 * Rewrites, in each linking note of `snapshot`, the links that pointed at a renamed file, so they point at its new
 * path. Used per rename, and once for a whole batch ({@link BacklinkBatch}).
 *
 * @param params - The snapshot and how to find each renamed file's new path.
 */
async function editRenameBacklinks(params: EditRenameBacklinksParams): Promise<void> {
  const renamedFilePaths = getObsidianLibState('renamedFilePaths', new Set<string>()).value;
  const renamedLinks = getObsidianLibState('renamedLinkPaths', new Set<string>()).value;
  const linkIndexes = new Map<string, number>();
  await editBacklinksSnapshot(normalizeOptionalProperties<EditBacklinksSnapshotParams<string>>({
    abortSignal: params.abortSignal,
    app: params.app,
    linkUpdateProgressReporter: params.linkUpdateProgressReporter ?? undefined,
    pluginNoticeComponent: params.pluginNoticeComponent,
    referenceConverter: ({ payload: oldAttachmentPath, reference, sourcePath: newBacklinkPath }) => {
      const linkIndex = (linkIndexes.get(newBacklinkPath) ?? 0) + 1;
      linkIndexes.set(newBacklinkPath, linkIndex);

      if (!oldAttachmentPath) {
        /*
         * A link that is not in the snapshot was either never ours to rewrite, or was already
         * rewritten by someone else (leaving it correct). Either way there is nothing to do -
         * but log it, because a silent skip here is exactly how
         * https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/60 stayed
         * invisible: every skipped link left a broken embed and reported nothing.
         */
        getLibDebugger('RenameDeleteHandler:updateBacklinks')(
          `No snapshot entry for link ${toJson(reference)} in ${newBacklinkPath}; leaving it unchanged.`
        );
        return;
      }

      renamedFilePaths.add(newBacklinkPath);
      renamedLinks.add(`${newBacklinkPath}//${String(linkIndex)}`);

      return updateLink(normalizeOptionalProperties<UpdateLinkParams>({
        app: params.app,
        newSourcePathOrFile: newBacklinkPath,
        newTargetPathOrFile: params.getNewTargetPath(oldAttachmentPath),
        oldTargetPathOrFile: oldAttachmentPath,
        reference,
        shouldUpdateFileNameAlias: params.shouldUpdateFileNameAliases
      }));
    },
    referenceIdentityKeyProvider: getLinkIdentityKey,
    resourceLockComponent: params.resourceLockComponent,
    shouldFailOnMissingFile: false,
    // The converter logs every link it declines, so it has to be shown the ones the snapshot does not name.
    shouldVisitUnmatchedReferences: true,
    snapshot: params.snapshot
  }));
}

/**
 * Lists the notes that would still reference a file once everything being deleted alongside it is gone.
 *
 * The same rule {@link deleteIfNotUsed} applies internally, restated here because the pre-pass has to know
 * WHICH notes survive — {@link deleteIfNotUsed} only hands that to its rescue callback, and by then the
 * walk has already started.
 *
 * @param params - The file, and the notes disappearing with it.
 * @returns The paths of the notes that keep the file alive. Empty means the file is free to go.
 */
async function findSurvivingNotePaths(params: FindSurvivingNotePathsParams): Promise<string[]> {
  const backlinks = await getBacklinksForFileSafe({ app: params.app, pathOrFile: params.file });
  for (const deletedNotePath of params.deletedNotePaths) {
    backlinks.clear(deletedNotePath);
  }
  return backlinks.keys();
}

/**
 * Builds the key under which a link is remembered while a rename is in flight.
 *
 * The rewrite has to match links captured BEFORE the attachments moved against the links the metadata cache
 * reports AFTER they moved, and the only thing that reliably survives that gap is the link's TEXT.
 * Deliberately excludes `position`: keying on the whole {@link Reference} meant that as soon as anything
 * edited the file in between — a co-installed plugin rewriting its own links, most often — every link below
 * the edit shifted its offsets, missed its key, and was skipped in silence, leaving the note with some embeds
 * rewritten and the rest broken. See
 * https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/60.
 *
 * Two links with identical text in one file necessarily resolve to the same target, so collapsing them onto
 * one key loses nothing.
 *
 * @param link - The link to build the key for.
 * @returns The key identifying the link by its text alone.
 */
function getLinkIdentityKey(link: Reference): string {
  return toJson({
    link: link.link,
    original: link.original
  });
}

/**
 * Moves a whole attachment unit folder, and reports where the linked attachment ended up inside it.
 *
 * @param params - The planned move, and the attachment whose new path is wanted.
 * @returns The attachment's path after the move, or `null` when the folder could not be resolved.
 */
async function moveUnitFolder(params: MoveUnitFolderParams): Promise<null | string> {
  const unitFolder = getFolderOrNull({ app: params.app, pathOrFolder: params.unitFolderMove.oldFolderPath });
  if (!unitFolder) {
    getLibDebugger('RenameDeleteHandler:moveUnitFolder')(
      `Cannot move the attachment unit folder ${params.unitFolderMove.oldFolderPath}; it could not be resolved.`
    );
    return null;
  }

  const newUnitFolderPath = await renameSafe({
    app: params.app,
    newPath: params.unitFolderMove.newFolderPath,
    oldPathOrAbstractFile: unitFolder
  });

  // The whole tree moved, so the attachment is wherever it was inside it, only rebased.
  return rebasePathOntoFolder({
    newFolderPath: newUnitFolderPath,
    oldFolderPath: params.unitFolderMove.oldFolderPath,
    path: params.attachmentPath
  });
}

/**
 * Moves out every attachment unit folder a deletion would otherwise tear apart, BEFORE the deletion walks
 * the tree.
 *
 * Doing it during the walk cannot work. {@link deleteIfNotUsed} lists a folder's children as paths and
 * walks them in order: a sibling reached before the linked attachment has no surviving backlink and is
 * deleted outright, so the unit is already gutted by the time the rescue hook fires; a sibling reached
 * after it no longer resolves, which reports the child as kept and leaves the folder the user actually
 * deleted standing. Moving the folder first means the walk never sees any of it.
 *
 * Only the folder case needs this. An attachment rescued on its own is moved by
 * {@link didRescueStillUsedAttachment} as it always was.
 *
 * @param params - The folder about to be walked, and everything needed to ask where its attachments belong.
 * @returns A {@link Promise} that resolves when every unit folder that had to move has moved.
 */
async function rescueStillUsedUnitFolders(params: RescueStillUsedUnitFoldersParams): Promise<void> {
  const settings = params.settingsManager.getSettings();
  if (!settings.getRescuePath) {
    return;
  }

  /*
   * Captured as PATHS, not as files: a `TFile` follows its own move, so the object cannot answer whether an
   * earlier move in this loop already carried it out of the tree. The path can.
   */
  const candidatePaths: string[] = [];
  Vault.recurseChildren(params.rootFolder, (child) => {
    if (isFile(child) && (params.shouldProtectIfStillUsed?.(child) ?? true)) {
      candidatePaths.push(child.path);
    }
  });

  for (const candidatePath of candidatePaths) {
    const candidateFile = getFileOrNull({ app: params.app, pathOrFile: candidatePath });
    if (!candidateFile) {
      /*
       * An earlier iteration moved the unit folder holding this file. It is out of the deletion's way, and
       * the answer that moved it governs the whole unit — asking again would offer to split it.
       */
      continue;
    }

    const survivingNotePaths = await findSurvivingNotePaths({
      app: params.app,
      deletedNotePaths: params.deletedNotePaths,
      file: candidateFile
    });

    if (survivingNotePaths.length === 0) {
      continue;
    }

    const rescueDestination = await settings.getRescuePath({
      attachmentPath: candidatePath,
      rescueDecisionScope: params.rescueDecisionScope,
      survivingNotePaths
    });

    if (rescueDestination === null) {
      continue;
    }

    const unitFolderMove = planUnitFolderMove({
      rescueDestination,
      rootFolderPath: params.rootFolder.path
    });

    if (!unitFolderMove) {
      continue;
    }

    try {
      const newAttachmentPath = await moveUnitFolder({
        app: params.app,
        attachmentPath: candidatePath,
        unitFolderMove
      });

      if (newAttachmentPath === null) {
        continue;
      }

      await waitForPendingLinkUpdates(params.app);

      getLibDebugger('RenameDeleteHandler:rescueStillUsedUnitFolders')(
        `Rescued the attachment unit folder ${unitFolderMove.oldFolderPath} to ${unitFolderMove.newFolderPath}.`
      );
      params.pluginNoticeComponent.showNotice(
        `Attachment ${candidatePath} is still used by other notes. Its folder was moved to ${unitFolderMove.newFolderPath}.`
      );
    } catch (error) {
      /*
       * A unit folder that could not be moved is left where it is, and the walk carries on: the attachment
       * is then kept in place by the rescue hook with the `attachmentIsStillUsed` notice, which is still
       * safe — the unit is torn apart rather than lost.
       */
      printError(new Error(`Failed to rescue the attachment unit folder ${unitFolderMove.oldFolderPath} to ${unitFolderMove.newFolderPath}`, { cause: error }));
    }
  }
}

/**
 * Puts back a property swapped out for a moment: the own property it had, or none, so a method inherited from the
 * prototype is inherited again.
 *
 * @param $object - The object the property was swapped on.
 * @param key - The property's key.
 * @param descriptor - Its own property descriptor before the swap, `undefined` when it had none.
 */
function restoreProperty($object: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty($object, key, descriptor);
  } else {
    Reflect.deleteProperty($object, key);
  }
}

/* v8 ignore stop */

export { EmptyFolderBehavior } from '@mnaoumov/obsidian-lib/vault';
