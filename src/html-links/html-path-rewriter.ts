import type { HtmlPathReference } from './html-path-references.ts';

import {
  findHtmlPathReferences,
  splitHtmlPath
} from './html-path-references.ts';

/**
 * What the rewriter needs to know about the vault, AFTER a batch of renames.
 */
export interface HtmlPathRewriteContext {
  /**
   * Whether a file exists at the path now.
   */
  readonly existsNow: (this: void, path: string) => boolean;

  /**
   * The note's path now.
   */
  readonly newNotePath: string;

  /**
   * The note's path before the batch: the same as {@link newNotePath} unless the note itself moved.
   */
  readonly oldNotePath: string;

  /**
   * The batch's renames, old path to new path, files only.
   */
  readonly renames: ReadonlyMap<string, string>;

  /**
   * Resolves a link path from a note the way Obsidian resolves an HTML `src`: `getFirstLinkpathDest`.
   *
   * @returns The path of the file it resolves to, or `null`.
   */
  readonly resolveNow: (this: void, linkpath: string, sourcePath: string) => null | string;

  /**
   * The shortest link path that resolves to the file from the note: `fileToLinktext`.
   */
  readonly shortestLinkpath: (this: void, targetPath: string, sourcePath: string, shouldKeepMdExtension: boolean) => string;
}

/**
 * The result of {@link rewriteHtmlPathReferences}.
 */
export interface HtmlPathRewriteResult {
  /**
   * The note's text with every rewritten value in place.
   */
  readonly content: string;

  /**
   * How many values were rewritten.
   */
  readonly rewrittenCount: number;
}

/**
 * How a value names its file, which its replacement keeps.
 */
type HtmlPathStyle = 'dot-relative' | 'folder-relative' | 'full' | 'root' | 'shortest';

interface OldTarget {
  readonly path: string;
  readonly style: HtmlPathStyle;
}

/**
 * Rewrites the HTML `src` and `href` paths in a note that a batch of renames left pointing at nothing.
 *
 * A value is touched only when it no longer resolves and, read against the vault as it was before the batch, it
 * named a file the batch moved — or the note itself moved and the value was relative to its old folder. A value
 * that still resolves is left alone, even when it now finds a different file of the same name: telling that apart
 * would need the resolution from before the batch, which Obsidian does not keep.
 *
 * The replacement keeps the value's style: `./` and `../` stay relative to the note, a leading `/` stays rooted, a
 * full path stays full, a path relative to the note's folder stays so, and a bare name stays the shortest link path
 * that resolves. Encoding, the query or fragment, and the quotes are kept, with quotes added when an unquoted value
 * gains a space.
 *
 * @param content - The note's current text.
 * @param context - The vault after the batch.
 * @returns The rewritten text and how many values changed.
 */
export function rewriteHtmlPathReferences(content: string, context: HtmlPathRewriteContext): HtmlPathRewriteResult {
  const references = findHtmlPathReferences(content);
  let rewrittenContent = content;
  let rewrittenCount = 0;

  // Last first, so each rewrite leaves the offsets of the ones still to come where they were.
  for (const reference of [...references].reverse()) {
    const newValue = getNewValue(reference, context);
    if (newValue === null) {
      continue;
    }

    rewrittenContent = rewrittenContent.slice(0, reference.valueStartOffset) + newValue + rewrittenContent.slice(reference.valueEndOffset);
    rewrittenCount++;
  }

  return {
    content: rewrittenContent,
    rewrittenCount
  };
}

/**
 * Whether a file was at the path before the batch: the batch moved it away, or it is there now and the batch did not
 * move it there.
 *
 * @param path - The path.
 * @param context - The vault after the batch.
 * @param newPaths - The batch's new paths.
 * @returns `true` when a file was there.
 */
function didExistBefore(path: string, context: HtmlPathRewriteContext, newPaths: ReadonlySet<string>): boolean {
  return context.renames.has(path) || (context.existsNow(path) && !newPaths.has(path));
}

function findOldTarget(linkpath: string, context: HtmlPathRewriteContext): null | OldTarget {
  const oldFolder = getFolder(context.oldNotePath);
  const newPaths = new Set(context.renames.values());
  function didExistBeforeBatch(path: string): boolean {
    return didExistBefore(path, context, newPaths);
  }

  if (isDotRelative(linkpath)) {
    const path = joinPath(oldFolder, linkpath);
    return path !== null && didExistBeforeBatch(path) ? { path, style: 'dot-relative' } : null;
  }

  if (linkpath.startsWith('/')) {
    const path = linkpath.slice(1);
    return didExistBeforeBatch(path) ? { path, style: 'root' } : null;
  }

  // A bare name is a shortest link path by construction, whatever folder it happened to sit in.
  if (linkpath.includes('/')) {
    if (didExistBeforeBatch(linkpath)) {
      return { path: linkpath, style: 'full' };
    }

    const folderRelativePath = joinPath(oldFolder, linkpath);
    if (oldFolder !== '' && folderRelativePath !== null && didExistBeforeBatch(folderRelativePath)) {
      return { path: folderRelativePath, style: 'folder-relative' };
    }
  }

  const matches = [...context.renames.keys()].filter((oldPath) => isLinkpathSuffix(linkpath, oldPath));
  const match = matches.length === 1 ? matches[0] : matches.find((oldPath) => getFolder(oldPath) === oldFolder);
  return match === undefined ? null : { path: match, style: 'shortest' };
}

function getFolder(path: string): string {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex === -1 ? '' : path.slice(0, slashIndex);
}

function getNewPathText(oldTarget: OldTarget, linkpath: string, newTargetPath: string, context: HtmlPathRewriteContext): string {
  const newFolder = getFolder(context.newNotePath);
  switch (oldTarget.style) {
    case 'dot-relative': {
      const relativePath = getRelativePath(newFolder, newTargetPath);
      return relativePath.startsWith('../') ? relativePath : `./${relativePath}`;
    }
    case 'folder-relative': {
      return getRelativePath(newFolder, newTargetPath);
    }
    case 'full': {
      return newTargetPath;
    }
    case 'root': {
      return `/${newTargetPath}`;
    }
    // 'shortest', the one style left.
    default: {
      return context.shortestLinkpath(newTargetPath, context.newNotePath, linkpath.toLowerCase().endsWith('.md'));
    }
  }
}

function getNewValue(reference: HtmlPathReference, context: HtmlPathRewriteContext): null | string {
  const { decodedPath, isEncoded, suffix } = splitHtmlPath(reference.rawValue);
  if (isResolvableNow(decodedPath, context)) {
    return null;
  }

  const oldTarget = findOldTarget(decodedPath, context);
  if (oldTarget === null) {
    return null;
  }

  const newTargetPath = context.renames.get(oldTarget.path) ?? oldTarget.path;
  if (!context.existsNow(newTargetPath)) {
    return null;
  }

  const newPathText = getNewPathText(oldTarget, decodedPath, newTargetPath, context);
  const newValue = (isEncoded ? encodeURI(newPathText) : newPathText) + suffix;
  if (newValue === reference.rawValue) {
    return null;
  }

  return reference.isQuoted || !/[\s"'<>=`]/.test(newValue) ? newValue : `"${newValue.replaceAll('"', '&quot;')}"`;
}

function getRelativePath(fromFolder: string, toPath: string): string {
  const fromSegments = fromFolder === '' ? [] : fromFolder.split('/');
  const toSegments = toPath.split('/');
  let commonLength = 0;
  while (
    commonLength < fromSegments.length
    && commonLength < toSegments.length - 1
    && fromSegments[commonLength] === toSegments[commonLength]
  ) {
    commonLength++;
  }

  return [...Array.from({ length: fromSegments.length - commonLength }, () => '..'), ...toSegments.slice(commonLength)].join('/');
}

function isDotRelative(linkpath: string): boolean {
  return linkpath.startsWith('./') || linkpath.startsWith('../');
}

/**
 * Whether a bare or partial link path could have resolved to the file, the way Obsidian matches a link path: the
 * whole path or a trailing run of its segments, case-insensitively, with a note's `.md` optional.
 *
 * @param linkpath - The decoded link path.
 * @param path - The file's full path.
 * @returns `true` when the link path names the file.
 */
function isLinkpathSuffix(linkpath: string, path: string): boolean {
  const candidates = [path.toLowerCase()];
  if (candidates[0]?.endsWith('.md')) {
    candidates.push(candidates[0].slice(0, -'.md'.length));
  }

  const lowerLinkpath = linkpath.toLowerCase();
  return candidates.some((candidate) => candidate === lowerLinkpath || candidate.endsWith(`/${lowerLinkpath}`));
}

function isResolvableNow(linkpath: string, context: HtmlPathRewriteContext): boolean {
  if (isDotRelative(linkpath)) {
    const path = joinPath(getFolder(context.newNotePath), linkpath);
    return path !== null && context.existsNow(path);
  }

  return linkpath.startsWith('/') ? context.existsNow(linkpath.slice(1)) : context.resolveNow(linkpath, context.newNotePath) !== null;
}

/**
 * Joins a relative path onto a folder, resolving `.` and `..`.
 *
 * @param folder - The folder, `''` for the vault root.
 * @param relativePath - The path to join.
 * @returns The joined path, or `null` when it climbs above the vault root.
 */
function joinPath(folder: string, relativePath: string): null | string {
  const segments = folder === '' ? [] : folder.split('/');
  for (const segment of relativePath.split('/')) {
    if (segment === '..') {
      if (segments.length === 0) {
        return null;
      }

      segments.pop();
    } else if (segment !== '.' && segment !== '') {
      segments.push(segment);
    }
  }

  return segments.join('/');
}
