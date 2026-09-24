/**
 * @file
 *
 * Answers "which references resolve to this file?" by looking only at the notes that COULD hold one, instead of
 * resolving every reference in the vault.
 *
 * Obsidian's `metadataCache.getBacklinksForFile(file)` is not an index lookup. Read out of the 1.14.2 bundle, it is
 * `iterateAllRefs` — every `frontmatterLinks`, `links` and `embeds` entry of every cached note, plus every
 * reference each `linkUpdaters` entry (the canvas one) reports — with one `getFirstLinkpathDest` per reference,
 * keeping those that resolve to `file`. That is ~115 ms at 100k references and ~320 ms at 250k, and the rename
 * handler used to take it twice per renamed file, so a 1000-file folder rename in a 50k-note vault spent 473 s in
 * 2001 walks and froze the renderer for minutes.
 *
 * What makes a narrower answer exact is a property of Obsidian's `getLinkpathDest`: every branch of it can only
 * return a file whose lowercased name is the lowercased last `/` segment of the linkpath, or that segment plus
 * `.md`. The one exception is the empty linkpath (`[[#Heading]]`), which returns the source note itself. So a
 * note can hold a reference to `file` only if it holds a reference whose last segment matches one of `file`'s
 * name keys, or if it IS `file`. This module indexes notes by those segments, takes the candidates for `file`,
 * and runs Obsidian's own predicate — `getFirstLinkpathDest(linkpath, source) === file` — over the candidates'
 * references only. The candidates are a superset of the real backlinks and the predicate is the same one, so
 * the answer is the one the full walk gives, a file registered at a non-existing path included.
 *
 * The index is kept fresh without listening to anything. `metadataCache.fileCache` maps a note to the hash of
 * its content, and the references are a function of that hash, so each query compares every note's hash
 * against the one it was indexed at and re-reads only the notes that changed. That is one property comparison
 * per note and no resolution at all, the same order as the scan Obsidian itself runs on every rename
 * (`updateRelatedLinks`). Depending on no event also means depending on no event ORDER — which matters, because
 * the handler's own capture runs inside the vault `rename` event.
 *
 * The `linkUpdaters` side is still walked in full on every query. In 1.14.2 the only updater is the canvas
 * one, whose references live in the canvas index rather than in `fileCache`, so there is no hash to key them
 * by; a vault's canvases hold a small fraction of its references.
 */

import type { CustomArrayDict } from '@obsidian-typings/obsidian-public-latest';
import type {
  App,
  CachedMetadata,
  Reference,
  TFile
} from 'obsidian';
import type { PathOrFile } from 'obsidian-dev-utils/obsidian/file-system';
import type { GetBacklinksForFileSafeWrapper } from 'obsidian-dev-utils/obsidian/metadata-cache';

import {
  CustomArrayDictImpl,
  isFrontmatterLinkCache,
  isReferenceCache
} from '@obsidian-typings/obsidian-public-latest/implementations';
import { getNestedPropertyValue } from 'obsidian-dev-utils/object-utils';
import { retryWithTimeoutNotice } from 'obsidian-dev-utils/obsidian/async-with-notice';
import {
  getFile,
  getFileOrNull,
  getPath
} from 'obsidian-dev-utils/obsidian/file-system';
import { parseFrontmatter } from 'obsidian-dev-utils/obsidian/frontmatter';
import { toFrontmatterLinkCacheWithOffsets } from 'obsidian-dev-utils/obsidian/frontmatter-link-cache-with-offsets';
import {
  ensureMetadataCacheReady,
  registerFiles
} from 'obsidian-dev-utils/obsidian/metadata-cache';
import {
  readSafe,
  saveNote
} from 'obsidian-dev-utils/obsidian/vault';
import { ensureNonNullable } from 'obsidian-dev-utils/type-guards';

const MARKDOWN_SUFFIX = '.md';

/**
 * Indexes every cached note by the last path segment of each reference it holds, and answers backlink
 * queries from that index. See the file header for why the answer is exact.
 */
export class BacklinkIndex {
  private readonly app: App;
  private readonly indexedHashes = new Map<string, string>();
  private readonly nameKeySourcePaths = new Map<string, Set<string>>();
  private readonly sourcePathNameKeys = new Map<string, Set<string>>();

  /**
   * Creates the index. Nothing is read until the first query.
   *
   * @param app - The Obsidian app instance.
   */
  public constructor(app: App) {
    this.app = app;
  }

  /**
   * The same answer as `app.metadataCache.getBacklinksForFile(file)`, from the candidate notes only.
   *
   * @param file - The file whose backlinks to find. It may be a non-existing file registered for the query.
   * @returns The references that resolve to `file`, keyed by the path of the note or canvas holding them.
   */
  public getBacklinksForFile(file: TFile): CustomArrayDict<Reference> {
    this.refresh();

    const metadataCache = this.app.metadataCache;
    const backlinks = new CustomArrayDictImpl<Reference>();

    // The file itself is a candidate for its own `[[#Heading]]` references, whose empty linkpath names no segment.
    const candidateSourcePaths = new Set<string>([file.path]);
    for (const nameKey of getTargetNameKeys(file.name)) {
      for (const sourcePath of this.nameKeySourcePaths.get(nameKey) ?? []) {
        candidateSourcePaths.add(sourcePath);
      }
    }

    for (const sourcePath of candidateSourcePaths) {
      for (const reference of getCacheReferences(this.getCachedMetadata(sourcePath))) {
        collect(sourcePath, reference);
      }
    }

    for (const linkUpdater of Object.values(metadataCache.linkUpdaters)) {
      linkUpdater?.iterateReferences(collect);
    }

    return backlinks;

    function collect(sourcePath: string, reference: Reference): void {
      if (metadataCache.getFirstLinkpathDest(getLinkpath(reference.link), sourcePath) === file) {
        backlinks.add(sourcePath, reference);
      }
    }
  }

  /**
   * The same answer as `obsidian-dev-utils`' `getBacklinksForFileOrPath`: the backlinks of a path that may no
   * longer exist, with a file registered there for the duration of the query.
   *
   * @param pathOrFile - The path or file whose backlinks to find.
   * @returns The references that resolve to it.
   */
  public getBacklinksForFileOrPath(pathOrFile: PathOrFile): CustomArrayDict<Reference> {
    const file = getFile({ app: this.app, pathOrFile, shouldIncludeNonExisting: true });
    using _registration = registerFiles(this.app, [file]);
    return this.getBacklinksForFile(file);
  }

  /**
   * The same contract as `obsidian-dev-utils`' `getBacklinksForFileSafe`, with the per-attempt lookup taken
   * from this index instead of the full walk.
   *
   * When a backlink-cache plugin grafts its `safe` overload onto `getBacklinksForFile`, that answer is used
   * unchanged, exactly as the library does. Otherwise every note found is saved and re-read, and the lookup
   * is retried until each reference's cached text matches the note's current text. Like the library's, this
   * is NOT a pure read: saving a note saves an open editor's unsaved changes.
   *
   * @param pathOrFile - The path or file whose backlinks to find. It must exist, or be registered.
   * @returns A {@link Promise} that resolves to the references that resolve to it.
   */
  public async getBacklinksForFileSafe(pathOrFile: PathOrFile): Promise<CustomArrayDict<Reference>> {
    const safeOverload = (this.app.metadataCache.getBacklinksForFile as Partial<GetBacklinksForFileSafeWrapper>).safe;
    if (safeOverload) {
      return await safeOverload(pathOrFile);
    }

    let backlinks: CustomArrayDict<Reference> = new CustomArrayDictImpl<Reference>();
    await retryWithTimeoutNotice({
      operationFunction: async (abortSignal) => {
        abortSignal.throwIfAborted();
        const file = getFile({ app: this.app, pathOrFile });
        await ensureMetadataCacheReady(this.app);
        abortSignal.throwIfAborted();
        backlinks = this.getBacklinksForFileOrPath(file);
        for (const [notePath, links] of backlinks.data) {
          abortSignal.throwIfAborted();
          if (!await this.isBacklinkNoteCurrent(notePath, links)) {
            return false;
          }
          abortSignal.throwIfAborted();
        }
        return true;
      },
      operationName: `Get backlinks for ${getPath(this.app, pathOrFile)}`,
      pluginNoticeComponent: null,
      shouldShowTimeoutNotice: true
    });

    return backlinks;
  }

  private getCachedMetadata(sourcePath: string): CachedMetadata | undefined {
    const hash = this.app.metadataCache.fileCache[sourcePath]?.hash;
    return hash === undefined ? undefined : this.app.metadataCache.metadataCache[hash];
  }

  private indexSource(sourcePath: string, hash: string): void {
    this.removeSource(sourcePath);
    const cache = this.app.metadataCache.metadataCache[hash];
    /*
     * A note's `fileCache` entry can carry its new hash before the metadata for that hash is stored. Recording
     * the hash then would pin the note at "no references" until its content changed again, so leave it
     * unrecorded and let the next query look again.
     */
    if (!cache) {
      return;
    }

    const nameKeys = new Set<string>();
    for (const reference of getCacheReferences(cache)) {
      nameKeys.add(getReferenceNameKey(reference.link));
    }
    for (const nameKey of nameKeys) {
      let sourcePaths = this.nameKeySourcePaths.get(nameKey);
      if (!sourcePaths) {
        sourcePaths = new Set<string>();
        this.nameKeySourcePaths.set(nameKey, sourcePaths);
      }
      sourcePaths.add(sourcePath);
    }
    this.sourcePathNameKeys.set(sourcePath, nameKeys);
    this.indexedHashes.set(sourcePath, hash);
  }

  private async isBacklinkNoteCurrent(notePath: string, links: readonly Reference[]): Promise<boolean> {
    const note = getFileOrNull({ app: this.app, pathOrFile: notePath });
    if (!note) {
      return false;
    }

    await saveNote(this.app, note);
    const content = await readSafe(this.app, note);
    if (!content) {
      return false;
    }
    const frontmatter = parseFrontmatter(content);

    for (const link of links) {
      let actualLink: string;
      if (isReferenceCache(link)) {
        actualLink = content.slice(link.position.start.offset, link.position.end.offset);
      } else if (isFrontmatterLinkCache(link)) {
        const propertyValue = getNestedPropertyValue(frontmatter, link.key);
        if (typeof propertyValue !== 'string') {
          return false;
        }

        const linkWithOffsets = toFrontmatterLinkCacheWithOffsets(link);
        actualLink = propertyValue.slice(linkWithOffsets.startOffset, linkWithOffsets.endOffset);
      } else {
        // The library's loop stops checking at the first reference that is neither kind, and so does this one.
        return true;
      }
      if (actualLink !== link.original) {
        return false;
      }
    }

    return true;
  }

  private refresh(): void {
    const fileCache = this.app.metadataCache.fileCache;

    for (const sourcePath of this.sourcePathNameKeys.keys()) {
      if (!Object.hasOwn(fileCache, sourcePath)) {
        this.removeSource(sourcePath);
      }
    }

    for (const [sourcePath, { hash }] of Object.entries(fileCache)) {
      if (this.indexedHashes.get(sourcePath) !== hash) {
        this.indexSource(sourcePath, hash);
      }
    }
  }

  private removeSource(sourcePath: string): void {
    for (const nameKey of this.sourcePathNameKeys.get(sourcePath) ?? []) {
      const sourcePaths = ensureNonNullable(this.nameKeySourcePaths.get(nameKey));
      sourcePaths.delete(sourcePath);
      if (sourcePaths.size === 0) {
        this.nameKeySourcePaths.delete(nameKey);
      }
    }
    this.sourcePathNameKeys.delete(sourcePath);
    this.indexedHashes.delete(sourcePath);
  }
}

/**
 * Lists a cached note's references in the order Obsidian's own walk visits them: `frontmatterLinks`, then
 * `links`, then `embeds`.
 *
 * @param cache - The note's cached metadata.
 * @returns The note's references.
 */
function getCacheReferences(cache: CachedMetadata | undefined): Reference[] {
  if (!cache) {
    return [];
  }
  return [...cache.frontmatterLinks ?? [], ...cache.links ?? [], ...cache.embeds ?? []];
}

/**
 * Strips the subpath from a link, the way Obsidian's `getLinkpath` does.
 *
 * @param link - The link text, such as `folder/Note#Heading`.
 * @returns The linkpath, such as `folder/Note`.
 */
function getLinkpath(link: string): string {
  const hashIndex = link.indexOf('#');
  return hashIndex === -1 ? link : link.slice(0, hashIndex);
}

/**
 * The key a reference is indexed under: the lowercased last `/` segment of its linkpath.
 *
 * @param link - The reference's link text.
 * @returns The key.
 */
function getReferenceNameKey(link: string): string {
  const linkpath = getLinkpath(link).toLowerCase();
  return linkpath.slice(linkpath.lastIndexOf('/') + 1);
}

/**
 * The keys under which a reference to a file with this name can be indexed. `getLinkpathDest` matches a
 * segment against the file's name, and against the name with `.md` appended, so a note named `Note.md` is
 * reachable from both `note.md` and `note`.
 *
 * @param fileName - The file's name, extension included.
 * @returns The keys.
 */
function getTargetNameKeys(fileName: string): string[] {
  const nameKey = fileName.toLowerCase();
  return nameKey.endsWith(MARKDOWN_SUFFIX) ? [nameKey, nameKey.slice(0, -MARKDOWN_SUFFIX.length)] : [nameKey];
}
