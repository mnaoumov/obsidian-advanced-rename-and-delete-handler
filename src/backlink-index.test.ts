import type {
  App,
  CachedMetadata,
  Reference,
  ReferenceCache,
  TFile
} from 'obsidian';

import { castTo } from 'obsidian-dev-utils/object-utils';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { BacklinkIndex } from './backlink-index.ts';

interface CallCounter {
  count: number;
}

interface FakeCanvasReference {
  readonly reference: Reference;
  readonly sourcePath: string;
}

interface FakeFileCacheEntry {
  readonly hash: string;
}

interface FakeVault {
  readonly app: App;
  readonly canvasReferences: FakeCanvasReference[];
  readonly contents: Map<string, string>;
  readonly files: Map<string, TFile>;
  readonly resolveCalls: CallCounter;
  setNote: (path: string, cache: CachedMetadata | undefined, hash?: string) => void;
}

const {
  mockEnsureMetadataCacheReady,
  mockReadSafe,
  mockRegisterFiles,
  mockSaveNote
} = vi.hoisted(() => ({
  mockEnsureMetadataCacheReady: vi.fn(),
  mockReadSafe: vi.fn(),
  mockRegisterFiles: vi.fn(),
  mockSaveNote: vi.fn()
}));

interface PathOrFileParams {
  readonly pathOrFile: string | TFile;
}

interface RetryParams {
  readonly operationFunction: (abortSignal: AbortSignal) => Promise<boolean>;
}

let currentVault: FakeVault;

vi.mock('obsidian-dev-utils/obsidian/async-with-notice', () => ({
  retryWithTimeoutNotice: async (params: RetryParams): Promise<void> => {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (await params.operationFunction(new AbortController().signal)) {
        return;
      }
    }
  }
}));

vi.mock('obsidian-dev-utils/obsidian/file-system', () => ({
  getFile: ({ pathOrFile }: PathOrFileParams): TFile => typeof pathOrFile === 'string' ? currentVault.files.get(pathOrFile) ?? makeFile(pathOrFile) : pathOrFile,
  getFileOrNull: ({ pathOrFile }: PathOrFileParams): null | TFile => typeof pathOrFile === 'string' ? currentVault.files.get(pathOrFile) ?? null : pathOrFile,
  getPath: (_app: App, pathOrFile: string | TFile): string => typeof pathOrFile === 'string' ? pathOrFile : pathOrFile.path,
  isCanvasFile: (file: TFile): boolean => file.path.endsWith('.canvas')
}));

vi.mock('obsidian-dev-utils/obsidian/metadata-cache', () => ({
  ensureMetadataCacheReady: mockEnsureMetadataCacheReady,
  registerFiles: mockRegisterFiles
}));

vi.mock('obsidian-dev-utils/obsidian/vault', () => ({
  readSafe: mockReadSafe,
  saveNote: mockSaveNote
}));

function createVault(): FakeVault {
  const files = new Map<string, TFile>();
  const contents = new Map<string, string>();
  const fileCache: Record<string, FakeFileCacheEntry> = {};
  const metadataCacheByHash: Record<string, CachedMetadata> = {};
  const canvasReferences: FakeCanvasReference[] = [];
  const resolveCalls: CallCounter = { count: 0 };

  /*
   * A resolver with the one property the index relies on: it only ever returns a file whose lowercased name is
   * the lowercased last segment of the linkpath, or that segment plus `.md`, or the source itself for an empty
   * linkpath. A linkpath with a folder in it must match the path; a bare one takes the first file by name.
   */
  function getFirstLinkpathDestination(linkpath: string, sourcePath: string): null | TFile {
    resolveCalls.count++;
    if (linkpath === '') {
      return files.get(sourcePath) ?? null;
    }
    const lower = linkpath.toLowerCase();
    const segment = lower.slice(lower.lastIndexOf('/') + 1);
    for (const file of files.values()) {
      const name = file.name.toLowerCase();
      if (name !== segment && name !== `${segment}.md`) {
        continue;
      }
      if (!lower.includes('/')) {
        return file;
      }
      const path = file.path.toLowerCase();
      if (path === lower || path === `${lower}.md`) {
        return file;
      }
    }
    return null;
  }

  const app = castTo<App>({
    metadataCache: {
      fileCache,
      getBacklinksForFile: vi.fn(),
      // eslint-disable-next-line unicorn/name-replacements -- Obsidian's own method name.
      getFirstLinkpathDest: getFirstLinkpathDestination,
      linkUpdaters: {
        canvas: {
          iterateReferences(callback: (sourcePath: string, reference: Reference) => void): void {
            for (const { reference, sourcePath } of canvasReferences) {
              callback(sourcePath, reference);
            }
          }
        },
        missing: undefined
      },
      metadataCache: metadataCacheByHash
    }
  });

  let hashCounter = 0;

  return {
    app,
    canvasReferences,
    contents,
    files,
    resolveCalls,
    setNote(path: string, cache: CachedMetadata | undefined, hash?: string): void {
      if (!files.has(path)) {
        files.set(path, makeFile(path));
      }
      hashCounter++;
      const newHash = hash ?? `hash-${String(hashCounter)}`;
      fileCache[path] = { hash: newHash };
      if (cache) {
        metadataCacheByHash[newHash] = cache;
      }
    }
  };
}

/**
 * The walk Obsidian's `getBacklinksForFile` makes, restated against the fake vault: every cached note's
 * references plus the link updaters', each resolved.
 *
 * @param vault - The fake vault.
 * @param file - The target.
 * @returns The backlinks, keyed by source path, each list in visiting order.
 */
function fullWalk(vault: FakeVault, file: TFile): Map<string, Reference[]> {
  const result = new Map<string, Reference[]>();
  const metadataCache = vault.app.metadataCache;
  for (const [sourcePath, entry] of Object.entries(metadataCache.fileCache)) {
    const cache = metadataCache.metadataCache[entry.hash];
    for (const reference of [...cache?.frontmatterLinks ?? [], ...cache?.links ?? [], ...cache?.embeds ?? []]) {
      collect(sourcePath, reference);
    }
  }
  for (const { reference, sourcePath } of vault.canvasReferences) {
    collect(sourcePath, reference);
  }
  return result;

  function collect(sourcePath: string, reference: Reference): void {
    const hashIndex = reference.link.indexOf('#');
    const linkpath = hashIndex === -1 ? reference.link : reference.link.slice(0, hashIndex);
    if (metadataCache.getFirstLinkpathDest(linkpath, sourcePath) !== file) {
      return;
    }
    const list = result.get(sourcePath) ?? [];
    list.push(reference);
    result.set(sourcePath, list);
  }
}

function getTestFile(path: string): TFile {
  const file = currentVault.files.get(path);
  if (!file) {
    throw new Error(`No file at ${path}.`);
  }
  return file;
}

function link(text: string, start = 0): ReferenceCache {
  return {
    link: text,
    original: `[[${text}]]`,
    position: {
      end: { col: start + text.length + 4, line: 0, offset: start + text.length + 4 },
      start: { col: start, line: 0, offset: start }
    }
  };
}

function makeFile(path: string): TFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dotIndex = name.lastIndexOf('.');
  return castTo<TFile>({
    basename: dotIndex === -1 ? name : name.slice(0, dotIndex),
    extension: dotIndex === -1 ? '' : name.slice(dotIndex + 1),
    name,
    path
  });
}

function toMap(backlinks: ReturnType<BacklinkIndex['getBacklinksForFile']>): Map<string, Reference[]> {
  return new Map(backlinks.keys().map((key) => [key, backlinks.get(key) ?? []]));
}

describe('BacklinkIndex', () => {
  beforeEach(() => {
    currentVault = createVault();
    vi.clearAllMocks();
    mockRegisterFiles.mockReturnValue({ [Symbol.dispose]: vi.fn() });
  });

  describe('getBacklinksForFile', () => {
    it('gives the full walk answer for every file of a randomized vault', () => {
      const vault = currentVault;
      const NOTE_COUNT = 60;
      const LINKS_PER_NOTE = 4;
      let seed = 42;
      const names = ['Alpha', 'beta', 'Gamma.Delta', 'image.png', 'Epsilon'];
      const folders = ['', 'a/', 'a/b/', 'C/'];
      const paths: string[] = [];
      for (let index_ = 0; index_ < NOTE_COUNT; index_++) {
        const name = names[random(names.length)] ?? '';
        const folder = folders[random(folders.length)] ?? '';
        const extension = name.endsWith('.png') ? '' : '.md';
        const path = `${folder}${name}${extension}`;
        if (!paths.includes(path)) {
          paths.push(path);
        }
      }
      for (const path of paths) {
        vault.files.set(path, makeFile(path));
      }
      const linkTargets = [...paths.map((path) => path.replace(/\.md$/u, '')), ...names, 'ALPHA', 'missing', '', 'a/beta#Heading', 'image.png#x'];
      for (const path of paths) {
        if (path.endsWith('.png')) {
          continue;
        }
        const links: ReferenceCache[] = [];
        for (let index_ = 0; index_ < LINKS_PER_NOTE; index_++) {
          links.push(link(linkTargets[random(linkTargets.length)] ?? ''));
        }
        vault.setNote(path, { embeds: [link('image.png')], frontmatterLinks: [{ key: 'up', link: 'Alpha', original: 'Alpha' }], links });
      }
      vault.canvasReferences.push({ reference: link('beta'), sourcePath: 'board.canvas' }, { reference: link('a/b/Epsilon'), sourcePath: 'board.canvas' });

      const index = new BacklinkIndex(vault.app);
      for (const file of vault.files.values()) {
        expect(toMap(index.getBacklinksForFile(file))).toEqual(fullWalk(vault, file));
      }

      function random(limit: number): number {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed % limit;
      }
    });

    it('resolves only the candidates, not every reference in the vault', () => {
      const vault = currentVault;
      const UNRELATED_NOTE_COUNT = 200;
      for (let index_ = 0; index_ < UNRELATED_NOTE_COUNT; index_++) {
        vault.setNote(`notes/note-${String(index_)}.md`, { links: [link(`note-${String((index_ + 1) % UNRELATED_NOTE_COUNT)}`)] });
      }
      vault.setNote('target.md', {});
      vault.setNote('holder.md', { links: [link('target'), link('note-1')] });

      const index = new BacklinkIndex(vault.app);
      const target = getTestFile('target.md');
      vault.resolveCalls.count = 0;
      expect(index.getBacklinksForFile(target).keys()).toEqual(['holder.md']);
      expect(vault.resolveCalls.count).toBe(2);
    });

    it('finds a note\'s own empty-linkpath reference', () => {
      currentVault.setNote('self.md', { links: [link('#Heading')] });
      const index = new BacklinkIndex(currentVault.app);
      expect(index.getBacklinksForFile(getTestFile('self.md')).keys()).toEqual(['self.md']);
    });

    it('re-reads a note whose hash changed and forgets a note that left the cache', () => {
      const vault = currentVault;
      vault.setNote('target.md', {});
      vault.setNote('holder.md', { links: [link('target')] });
      vault.setNote('second.md', { links: [link('target')] });
      const target = getTestFile('target.md');
      const index = new BacklinkIndex(vault.app);
      expect(index.getBacklinksForFile(target).keys()).toEqual(['holder.md', 'second.md']);

      vault.setNote('holder.md', { links: [link('elsewhere')] });
      vault.setNote('other.md', { links: [link('Target')] });
      expect(index.getBacklinksForFile(target).keys()).toEqual(['second.md', 'other.md']);

      delete vault.app.metadataCache.fileCache['other.md'];
      expect(index.getBacklinksForFile(target).keys()).toEqual(['second.md']);

      vault.setNote('second.md', { links: [] });
      expect(index.getBacklinksForFile(target).keys()).toEqual([]);
    });

    it('looks again at a note whose metadata was not stored yet when it was first seen', () => {
      const vault = currentVault;
      vault.setNote('target.md', {});
      vault.setNote('holder.md', undefined, 'pending-hash');
      const target = getTestFile('target.md');
      const index = new BacklinkIndex(vault.app);
      expect(index.getBacklinksForFile(target).keys()).toEqual([]);

      vault.app.metadataCache.metadataCache['pending-hash'] = { links: [link('target')] };
      expect(index.getBacklinksForFile(target).keys()).toEqual(['holder.md']);
    });
  });

  describe('getBacklinksForFileOrPath', () => {
    it('registers the path for the duration of the query and disposes the registration', () => {
      const dispose = vi.fn();
      mockRegisterFiles.mockReturnValue({ [Symbol.dispose]: dispose });
      currentVault.setNote('holder.md', { links: [link('gone')] });
      const index = new BacklinkIndex(currentVault.app);
      mockRegisterFiles.mockImplementation((_app: App, [file]: TFile[]) => {
        currentVault.files.set('gone.md', castTo<TFile>(file));
        return { [Symbol.dispose]: dispose };
      });

      expect(index.getBacklinksForFileOrPath('gone.md').keys()).toEqual(['holder.md']);
      expect(dispose).toHaveBeenCalledOnce();
    });
  });

  describe('getBacklinksForFileSafe', () => {
    it('defers to a backlink-cache plugin\'s safe overload when one is grafted on', async () => {
      const answer = { keys: (): string[] => ['from-overload.md'] };
      const safe = vi.fn().mockResolvedValue(answer);
      Object.assign(currentVault.app.metadataCache, { getBacklinksForFile: Object.assign(vi.fn(), { safe }) });
      const index = new BacklinkIndex(currentVault.app);

      expect(await index.getBacklinksForFileSafe('target.md')).toBe(answer);
      expect(safe).toHaveBeenCalledWith('target.md');
    });

    it('saves and re-reads every holder, and answers once each cached link matches the text', async () => {
      const vault = currentVault;
      vault.setNote('target.md', {});
      vault.setNote('holder.md', { links: [link('target', 0)] });
      vault.contents.set('holder.md', '[[target]]');
      mockReadSafe.mockImplementation((_app: App, note: TFile) => vault.contents.get(note.path));
      const index = new BacklinkIndex(vault.app);

      const backlinks = await index.getBacklinksForFileSafe('target.md');
      expect(backlinks.keys()).toEqual(['holder.md']);
      expect(mockEnsureMetadataCacheReady).toHaveBeenCalled();
      expect(mockSaveNote).toHaveBeenCalledWith(vault.app, vault.files.get('holder.md'));
    });

    it('retries while a holder\'s cached link disagrees with its text', async () => {
      const vault = currentVault;
      vault.setNote('target.md', {});
      vault.setNote('holder.md', { links: [link('target', 0)] });
      mockReadSafe.mockResolvedValueOnce('[[stale]]..').mockResolvedValueOnce('[[target]]');
      const index = new BacklinkIndex(vault.app);

      const backlinks = await index.getBacklinksForFileSafe('target.md');
      expect(backlinks.keys()).toEqual(['holder.md']);
      expect(mockReadSafe).toHaveBeenCalledTimes(2);
    });

    it('retries while a holder is missing or empty', async () => {
      const vault = currentVault;
      vault.setNote('target.md', {});
      vault.setNote('holder.md', { links: [link('target', 0)] });
      const holder = getTestFile('holder.md');
      vault.files.delete('holder.md');
      mockReadSafe.mockResolvedValueOnce('').mockResolvedValueOnce('[[target]]');
      const index = new BacklinkIndex(vault.app);
      let attempt = 0;
      mockEnsureMetadataCacheReady.mockImplementation(() => {
        attempt++;
        if (attempt === 2) {
          vault.files.set('holder.md', holder);
        }
      });

      const backlinks = await index.getBacklinksForFileSafe('target.md');
      expect(backlinks.keys()).toEqual(['holder.md']);
      expect(attempt).toBe(3);
    });

    it('checks a frontmatter link against the property value', async () => {
      const vault = currentVault;
      vault.setNote('target.md', {});
      vault.setNote('holder.md', { frontmatterLinks: [{ key: 'up', link: 'target', original: '[[target]]' }] });
      mockReadSafe
        .mockResolvedValueOnce('---\nup: 1\n---\n')
        .mockResolvedValueOnce('---\nup: "[[other]]"\n---\n')
        .mockResolvedValueOnce('---\nup: "[[target]]"\n---\n');
      const index = new BacklinkIndex(vault.app);

      const backlinks = await index.getBacklinksForFileSafe('target.md');
      expect(backlinks.keys()).toEqual(['holder.md']);
      expect(mockReadSafe).toHaveBeenCalledTimes(3);
    });

    it('stops checking at a reference that is neither a text nor a frontmatter link', async () => {
      const vault = currentVault;
      vault.setNote('target.md', {});
      vault.files.set('board.other', makeFile('board.other'));
      vault.canvasReferences.push({ reference: { link: 'target', original: '' }, sourcePath: 'board.other' });
      mockReadSafe.mockResolvedValue('{}');
      const index = new BacklinkIndex(vault.app);

      const backlinks = await index.getBacklinksForFileSafe('target.md');
      expect(backlinks.keys()).toEqual(['board.other']);
      expect(mockReadSafe).toHaveBeenCalledOnce();
    });

    it('takes a canvas as current without reading it, since a text-node position is an offset into the node', async () => {
      const vault = currentVault;
      vault.setNote('target.md', {});
      vault.files.set('board.canvas', makeFile('board.canvas'));
      // Obsidian's canvas index reports a text-node embed first, positioned at the start of the node's own text.
      vault.canvasReferences.push(
        { reference: link('target', 0), sourcePath: 'board.canvas' },
        { reference: { link: 'target', original: '' }, sourcePath: 'board.canvas' }
      );
      mockReadSafe.mockResolvedValue('{"nodes":[]}');
      const index = new BacklinkIndex(vault.app);

      const backlinks = await index.getBacklinksForFileSafe('target.md');
      expect(backlinks.keys()).toEqual(['board.canvas']);
      expect(mockReadSafe).not.toHaveBeenCalled();
      expect(mockSaveNote).not.toHaveBeenCalled();
    });
  });
});
