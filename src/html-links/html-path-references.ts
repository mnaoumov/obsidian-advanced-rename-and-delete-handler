import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';

/**
 * A path written in an HTML attribute of a note, such as the `src` of an `<img>` or the `href` of an `<a>`.
 */
export interface HtmlPathReference {
  /**
   * Whether the value is in quotes, so a rewritten value with a space in it needs no quotes added.
   */
  readonly isQuoted: boolean;

  /**
   * The value as written, without its quotes.
   */
  readonly rawValue: string;

  /**
   * The offset just past the value, excluding a closing quote.
   */
  readonly valueEndOffset: number;

  /**
   * The offset of the value's first character, excluding an opening quote.
   */
  readonly valueStartOffset: number;
}

/**
 * The parts of an attribute value that name a file: the path and whatever query or fragment follows it.
 */
export interface SplitHtmlPath {
  /**
   * The path, decoded when the value was percent-encoded.
   */
  readonly decodedPath: string;

  /**
   * Whether the path was percent-encoded, so its replacement is encoded the same way.
   */
  readonly isEncoded: boolean;

  /**
   * The `?query` or `#fragment` after the path, kept as written, or `''`.
   */
  readonly suffix: string;
}

interface OffsetRange {
  readonly end: number;
  readonly start: number;
}

const TAG_REG_EXP = /<[a-z][\w-]*(?<attributes>\s[^<>]*?)?\/?>/gi;
const PATH_ATTRIBUTE_REG_EXP = /\s(?:src|href)\s*=\s*(?<value>"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi;
const URL_SCHEME_REG_EXP = /^[a-z][a-z\d+.-]*:/i;
const FRONTMATTER_REG_EXP = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const FENCE_OPEN_REG_EXP = /^ {0,3}(?<fence>`{3,}|~{3,})/;
const INLINE_CODE_REG_EXP = /(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)/g;

/**
 * A fence line may be indented by up to this many spaces and still open or close a code block.
 */
const MAX_FENCE_INDENT = 3;
const COMMENT_REG_EXP = /<!--[\s\S]*?-->|%%[\s\S]*?%%/g;

/**
 * Finds every HTML `src` and `href` attribute in a note whose value can name a file in the vault.
 *
 * Obsidian keeps no index of these: its metadata cache records wikilinks and markdown links only, and its own
 * link update leaves HTML alone. So the note text is the only source. Values in frontmatter, code and comments are
 * skipped, since Obsidian renders none of them as HTML, and so are values that cannot be a vault path: an empty
 * one, a fragment (`#top`), a protocol-relative URL (`//host`) and anything with a URL scheme (`https:`, `data:`).
 *
 * @param content - The note's text.
 * @returns The references, in the order they appear.
 */
export function findHtmlPathReferences(content: string): HtmlPathReference[] {
  const skippedRanges = getSkippedRanges(content);
  const references: HtmlPathReference[] = [];

  for (const tagMatch of content.matchAll(TAG_REG_EXP)) {
    const attributes = tagMatch.groups?.['attributes'];
    if (attributes === undefined || isInsideRanges(tagMatch.index, skippedRanges)) {
      continue;
    }

    // The attributes start with whitespace, which the tag name cannot hold, so the first match is theirs.
    const attributesOffset = tagMatch.index + tagMatch[0].indexOf(attributes);

    for (const attributeMatch of attributes.matchAll(PATH_ATTRIBUTE_REG_EXP)) {
      const writtenValue = ensureNonNullable(attributeMatch.groups?.['value']);
      const isQuoted = writtenValue.startsWith('"') || writtenValue.startsWith('\'');
      const rawValue = isQuoted ? writtenValue.slice(1, -1) : writtenValue;
      if (!isVaultPathCandidate(rawValue)) {
        continue;
      }

      const valueEndOffset = attributesOffset + attributeMatch.index + attributeMatch[0].length - (isQuoted ? 1 : 0);
      references.push({
        isQuoted,
        rawValue,
        valueEndOffset,
        valueStartOffset: valueEndOffset - rawValue.length
      });
    }
  }

  return references;
}

/**
 * Splits an attribute value into the path it names and the query or fragment after it, decoding the path.
 *
 * Obsidian decodes the value before resolving it, so `x%20img.png` and `x img.png` name the same file. A value
 * that is not valid percent-encoding is taken as written.
 *
 * @param rawValue - The attribute value as written.
 * @returns The split value.
 */
export function splitHtmlPath(rawValue: string): SplitHtmlPath {
  const suffixIndex = rawValue.search(/[?#]/);
  const path = suffixIndex === -1 ? rawValue : rawValue.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : rawValue.slice(suffixIndex);
  let decodedPath = path;
  try {
    decodedPath = decodeURI(path);
  } catch {
    // Not valid percent-encoding: Obsidian takes such a value as written too.
  }

  return {
    decodedPath,
    isEncoded: decodedPath !== path,
    suffix
  };
}

function getFencedCodeRanges(content: string, startOffset: number): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  let offset = startOffset;
  let openFence: null | string = null;
  let openOffset = 0;

  while (offset < content.length) {
    const lineEndIndex = content.indexOf('\n', offset);
    const lineEnd = lineEndIndex === -1 ? content.length : lineEndIndex + 1;
    const line = content.slice(offset, lineEnd).replace(/\r?\n$/, '');

    if (openFence === null) {
      const fence = FENCE_OPEN_REG_EXP.exec(line)?.groups?.['fence'];
      if (fence !== undefined) {
        openFence = fence;
        openOffset = offset;
      }
    } else if (isFenceClose(line, openFence)) {
      ranges.push({ end: lineEnd, start: openOffset });
      openFence = null;
    }

    offset = lineEnd;
  }

  if (openFence !== null) {
    ranges.push({ end: content.length, start: openOffset });
  }

  return ranges;
}

function getSkippedRanges(content: string): OffsetRange[] {
  const frontmatterLength = FRONTMATTER_REG_EXP.exec(content)?.[0].length ?? 0;
  const ranges: OffsetRange[] = [];
  if (frontmatterLength > 0) {
    ranges.push({ end: frontmatterLength, start: 0 });
  }

  const fencedRanges = getFencedCodeRanges(content, frontmatterLength);
  ranges.push(...fencedRanges);

  for (const regExp of [INLINE_CODE_REG_EXP, COMMENT_REG_EXP]) {
    for (const match of content.matchAll(regExp)) {
      if (!isInsideRanges(match.index, ranges)) {
        ranges.push({ end: match.index + match[0].length, start: match.index });
      }
    }
  }

  return ranges;
}

function isFenceClose(line: string, openFence: string): boolean {
  const fenceChar = openFence.charAt(0);
  const trimmed = line.trim();
  return line.length - line.trimStart().length <= MAX_FENCE_INDENT
    && trimmed.length >= openFence.length
    && trimmed.replaceAll(fenceChar, '') === '';
}

function isInsideRanges(offset: number, ranges: readonly OffsetRange[]): boolean {
  return ranges.some((range) => range.start <= offset && offset < range.end);
}

function isVaultPathCandidate(rawValue: string): boolean {
  return rawValue !== ''
    && !rawValue.startsWith('#')
    && !rawValue.startsWith('//')
    && !URL_SCHEME_REG_EXP.test(rawValue);
}
