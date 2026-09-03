import type {
  App as AppOriginal,
  TFile
} from 'obsidian';

import { NoPriorityWinnerReason } from 'obsidian-dev-utils/obsidian/note-priority';
import { strictProxy } from 'obsidian-dev-utils/strict-proxy';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { PluginSettingsComponent } from './plugin-settings-component.ts';

import {
  PluginSettings,
  RescueAttachmentUsedByMultipleNotesMode
} from './plugin-settings.ts';
import { RescueDecisionScope } from './rescue-decision-scope.ts';
import {
  pickRescueNotePath,
  RescuePathResolver
} from './rescue-path-resolver.ts';

interface CreateResolverOptions {
  readonly attachmentFile?: null | TFile;
  readonly existingNotePaths?: readonly string[];
  readonly frontmatter?: Record<string, unknown>;
  readonly hasNoFileCache?: boolean;
  readonly settings?: Partial<PluginSettings>;
}

const ATTACHMENT_PATH = 'attachments/image.png';
const ATTACHMENT_FOLDER_PATH = 'Notes/attachments';

const { mockGetAttachmentFolderPath, mockShowRescueAmbiguityModal } = vi.hoisted(() => ({
  mockGetAttachmentFolderPath: vi.fn(),
  mockShowRescueAmbiguityModal: vi.fn()
}));

vi.mock('obsidian-dev-utils/obsidian/attachment-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('obsidian-dev-utils/obsidian/attachment-path')>();
  return {
    ...actual,
    getAttachmentFolderPath: mockGetAttachmentFolderPath
  };
});

vi.mock('./rescue-ambiguity-modal.ts', () => ({
  showRescueAmbiguityModal: mockShowRescueAmbiguityModal
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAttachmentFolderPath.mockResolvedValue(ATTACHMENT_FOLDER_PATH);
  // The dialog's own answer is asserted where it matters; everywhere else it declines, as a dismissal does.
  mockShowRescueAmbiguityModal.mockResolvedValue({ adoptingNotePath: null, shouldUseSameActionForRest: false });
});

function createResolver(options: CreateResolverOptions = {}): RescuePathResolver {
  const settings = Object.assign(new PluginSettings(), options.settings);
  const attachmentFile = options.attachmentFile === undefined
    ? strictProxy<TFile>({ name: 'image.png', path: ATTACHMENT_PATH })
    : options.attachmentFile;

  const noteFiles = new Map<string, TFile>(
    (options.existingNotePaths ?? []).map((notePath) => [notePath, strictProxy<TFile>({ path: notePath })])
  );

  const app = strictProxy<AppOriginal>({
    metadataCache: strictProxy<AppOriginal['metadataCache']>({
      getFileCache: vi.fn().mockReturnValue(options.hasNoFileCache ? null : { frontmatter: options.frontmatter ?? null })
    }),
    vault: strictProxy<AppOriginal['vault']>({
      getFileByPath: vi.fn((path: string) => path === ATTACHMENT_PATH ? attachmentFile : noteFiles.get(path) ?? null)
    })
  });

  return new RescuePathResolver({
    app,
    pluginSettingsComponent: strictProxy<PluginSettingsComponent>({ settings })
  });
}

describe('RescuePathResolver', () => {
  it('should decline when the rescue is switched off', async () => {
    const resolver = createResolver();

    const rescuePath = await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: ['Notes/keeper.md']
    });

    expect(rescuePath).toBeNull();
    expect(mockGetAttachmentFolderPath).not.toHaveBeenCalled();
  });

  it('should decline when the attachment no longer exists', async () => {
    const resolver = createResolver({
      attachmentFile: null,
      settings: { shouldRescueSharedAttachments: true }
    });

    const rescuePath = await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: ['Notes/keeper.md']
    });

    expect(rescuePath).toBeNull();
  });

  it('should move the attachment into the only surviving note\'s folder', async () => {
    const resolver = createResolver({ settings: { shouldRescueSharedAttachments: true } });

    const rescuePath = await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: ['Notes/keeper.md']
    });

    expect(rescuePath).toBe(`${ATTACHMENT_FOLDER_PATH}/image.png`);
  });

  it('should resolve the destination for the note that adopts the attachment', async () => {
    const resolver = createResolver({ settings: { shouldRescueSharedAttachments: true } });

    await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: ['Notes/keeper.md']
    });

    expect(mockGetAttachmentFolderPath).toHaveBeenCalledWith(expect.objectContaining({
      notePathOrFile: 'Notes/keeper.md'
    }));
  });

  it('should rank a surviving note by its frontmatter when the note exists', async () => {
    const resolver = createResolver({
      existingNotePaths: ['Notes/tagged.md'],
      frontmatter: { owner: true },
      settings: {
        notePriorities: ['property:owner=true', '.md'],
        shouldRescueSharedAttachments: true
      }
    });

    const rescuePath = await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: ['Notes/plain.md', 'Notes/tagged.md']
    });

    expect(rescuePath).toBe(`${ATTACHMENT_FOLDER_PATH}/image.png`);
    expect(mockGetAttachmentFolderPath).toHaveBeenCalledWith(expect.objectContaining({
      notePathOrFile: 'Notes/tagged.md'
    }));
  });

  it('should rank a note that exists but has no metadata cache yet', async () => {
    const resolver = createResolver({
      existingNotePaths: ['Notes/uncached.md'],
      hasNoFileCache: true,
      settings: {
        notePriorities: ['.excalidraw.md', '.md'],
        shouldRescueSharedAttachments: true
      }
    });

    const rescuePath = await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: ['Notes/uncached.md', 'Notes/drawing.excalidraw.md']
    });

    expect(rescuePath).toBe(`${ATTACHMENT_FOLDER_PATH}/image.png`);
  });

  it('should decline without asking when several notes survive and the mode is to leave it in place', async () => {
    const resolver = createResolver({
      settings: {
        rescueAttachmentUsedByMultipleNotesMode: RescueAttachmentUsedByMultipleNotesMode.Skip,
        shouldRescueSharedAttachments: true
      }
    });

    const rescuePath = await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: ['Notes/a.md', 'Notes/b.md']
    });

    expect(rescuePath).toBeNull();
    expect(mockShowRescueAmbiguityModal).not.toHaveBeenCalled();
  });

  it('should not ask when the deletion reported no surviving note at all', async () => {
    const resolver = createResolver({ settings: { shouldRescueSharedAttachments: true } });

    const rescuePath = await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: []
    });

    expect(rescuePath).toBeNull();
    expect(mockShowRescueAmbiguityModal).not.toHaveBeenCalled();
  });

  it('should let the priority list pick the winner among several surviving notes', async () => {
    const resolver = createResolver({
      settings: {
        notePriorities: ['.excalidraw.md', '.md'],
        shouldRescueSharedAttachments: true
      }
    });

    const rescuePath = await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: ['Notes/plain.md', 'Notes/drawing.excalidraw.md']
    });

    expect(rescuePath).toBe(`${ATTACHMENT_FOLDER_PATH}/image.png`);
    expect(mockGetAttachmentFolderPath).toHaveBeenCalledWith(expect.objectContaining({
      notePathOrFile: 'Notes/drawing.excalidraw.md'
    }));
  });

  it('should move the attachment into the note the user picks when the list settles nothing', async () => {
    const resolver = createResolver({ settings: { shouldRescueSharedAttachments: true } });
    mockShowRescueAmbiguityModal.mockResolvedValue({ adoptingNotePath: 'Notes/b.md', shouldUseSameActionForRest: false });

    const rescuePath = await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: ['Notes/a.md', 'Notes/b.md']
    });

    expect(rescuePath).toBe(`${ATTACHMENT_FOLDER_PATH}/image.png`);
    expect(mockGetAttachmentFolderPath).toHaveBeenCalledWith(expect.objectContaining({
      notePathOrFile: 'Notes/b.md'
    }));
  });

  it('should leave the attachment in place when the user declines to pick', async () => {
    const resolver = createResolver({ settings: { shouldRescueSharedAttachments: true } });

    const rescuePath = await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: ['Notes/a.md', 'Notes/b.md']
    });

    expect(rescuePath).toBeNull();
    expect(mockShowRescueAmbiguityModal).toHaveBeenCalledTimes(1);
  });

  it('should offer the surviving notes sorted, whatever order the deletion reported them in', async () => {
    const resolver = createResolver({ settings: { shouldRescueSharedAttachments: true } });

    await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: ['Notes/b.md', 'Notes/a.md']
    });

    expect(mockShowRescueAmbiguityModal).toHaveBeenCalledWith(expect.objectContaining({
      survivingNotePaths: ['Notes/a.md', 'Notes/b.md']
    }));
  });

  it.each([
    ['the list is empty', [], NoPriorityWinnerReason.EmptyList],
    ['nothing in the list matches', ['.canvas'], NoPriorityWinnerReason.NoMatch],
    ['the best rank is shared', ['.md'], NoPriorityWinnerReason.Tie]
  ])('should tell the user that %s', async (_description, notePriorities, expectedReason) => {
    const resolver = createResolver({
      settings: {
        notePriorities,
        shouldRescueSharedAttachments: true
      }
    });

    await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope: new RescueDecisionScope(),
      survivingNotePaths: ['Notes/a.md', 'Notes/b.md']
    });

    expect(mockShowRescueAmbiguityModal).toHaveBeenCalledWith(expect.objectContaining({
      noPriorityWinnerReason: expectedReason
    }));
  });

  it('should ask only once about an attachment the same deletion reports twice', async () => {
    const resolver = createResolver({ settings: { shouldRescueSharedAttachments: true } });
    mockShowRescueAmbiguityModal.mockResolvedValue({ adoptingNotePath: null, shouldUseSameActionForRest: false });
    const rescueDecisionScope = new RescueDecisionScope();
    rescueDecisionScope.enter();

    const survivingNotePaths = ['Notes/a.md', 'Notes/b.md'];
    await resolver.getRescuePath({ attachmentPath: ATTACHMENT_PATH, rescueDecisionScope, survivingNotePaths });
    await resolver.getRescuePath({ attachmentPath: ATTACHMENT_PATH, rescueDecisionScope, survivingNotePaths });

    expect(mockShowRescueAmbiguityModal).toHaveBeenCalledTimes(1);
  });

  it('should record an answer the user asked to stand for the rest of the deletion', async () => {
    const resolver = createResolver({ settings: { shouldRescueSharedAttachments: true } });
    mockShowRescueAmbiguityModal.mockResolvedValue({ adoptingNotePath: 'Notes/b.md', shouldUseSameActionForRest: true });
    const rescueDecisionScope = new RescueDecisionScope();
    rescueDecisionScope.enter();

    await resolver.getRescuePath({
      attachmentPath: ATTACHMENT_PATH,
      rescueDecisionScope,
      survivingNotePaths: ['Notes/a.md', 'Notes/b.md']
    });

    const neverAsked = vi.fn();
    const carriedDecision = await rescueDecisionScope.resolveDecision({
      ask: neverAsked,
      attachmentPath: 'other/chart.png',
      survivingNotePaths: ['Notes/b.md', 'Notes/c.md']
    });

    expect(carriedDecision).toEqual({ adoptingNotePath: 'Notes/b.md' });
    expect(neverAsked).not.toHaveBeenCalled();
  });
});

describe('pickRescueNotePath', () => {
  it('should return the single survivor without consulting the list', () => {
    const rank = vi.fn();

    const notePath = pickRescueNotePath({
      entries: [],
      rank,
      survivingNotePaths: ['only.md']
    });

    expect(notePath).toBe('only.md');
    expect(rank).not.toHaveBeenCalled();
  });

  it('should return null when nothing survives', () => {
    expect(pickRescueNotePath({
      entries: ['.md'],
      rank: vi.fn(),
      survivingNotePaths: []
    })).toBeNull();
  });

  it('should return null when the priority list is empty and several survive', () => {
    expect(pickRescueNotePath({
      entries: [],
      rank: vi.fn(),
      survivingNotePaths: ['a.md', 'b.md']
    })).toBeNull();
  });

  it('should return the highest-ranked survivor', () => {
    const ranks: Record<string, number> = { 'a.md': 5, 'b.md': 1 };

    expect(pickRescueNotePath({
      entries: ['.md'],
      rank: (notePath) => ranks[notePath] ?? Infinity,
      survivingNotePaths: ['a.md', 'b.md']
    })).toBe('b.md');
  });

  it('should return null on a tie', () => {
    expect(pickRescueNotePath({
      entries: ['.md'],
      rank: () => 1,
      survivingNotePaths: ['a.md', 'b.md']
    })).toBeNull();
  });
});
