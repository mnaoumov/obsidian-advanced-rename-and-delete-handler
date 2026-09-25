import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

/*
 * An Excalidraw drawing saved as a plain `.md` is an attachment, recognized by its `excalidraw-plugin`
 * frontmatter property (Custom Attachment Location issue #90). Excalidraw itself decides a Markdown file is
 * a drawing by that property, so the compound `.excalidraw.md` extension is a convention, not a guarantee.
 *
 * Driven through the published API's `isTreatedAsAttachment`, because that is the answer every consumer
 * reads: Custom Attachment Location's `isNoteEx` asks exactly this, so pinning it here is what lets that
 * plugin follow with no change of its own. A unit test mocks the metadata cache; this one needs Obsidian to
 * actually parse the frontmatter, which is the half a mock cannot vouch for.
 *
 * **It writes no settings, deliberately**: `property:excalidraw-plugin` is pinned as a DEFAULT, which is
 * where a regression would otherwise be invisible. It also keeps the suite out of the `migrateSettings`
 * dialog the settings-driving suites share. No other suite writes `treatAsAttachmentExtensions`.
 *
 * Cross-platform: a drawing made on a phone is the same file, and the manifest declares
 * `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';

interface AttachmentApiLike {
  getSettings: () => AttachmentSettingsLike;
  isTreatedAsAttachment: (path: string) => boolean;
}

interface AttachmentSettingsLike {
  readonly treatAsAttachmentExtensions: readonly string[];
}

interface ObsidianDevUtilsStateLike {
  readonly pluginApiRegistry?: PluginApiRegistryWrapperLike;
}

/**
 * The slice of the `obsidian-dev-utils` cross-plugin registry a closure reads the API from: the wire-level path
 * that library's Plugin API protocol guide freezes, so a suite reaches the plugin the way a consumer does.
 */
interface PluginApiRegistryHostLike {
  readonly __obsidianDevUtils?: ObsidianDevUtilsStateLike;
}

interface PluginApiRegistryLike {
  readonly records?: Partial<Record<string, readonly PublishedPluginApiRecordLike[]>>;
}

interface PluginApiRegistryWrapperLike {
  readonly value?: PluginApiRegistryLike;
}

interface PropertyProbeResult {
  readonly isCompoundExtensionDrawingAttachment: boolean;
  readonly isPlainNoteAttachment: boolean;
  readonly isPropertyDrawingAttachment: boolean;
  readonly treatAsAttachmentExtensions: readonly string[];
}

interface PublishedPluginApiRecordLike {
  readonly api: AttachmentApiLike;
  readonly isRevoked: boolean;
}

describe('An Excalidraw drawing saved as plain markdown', () => {
  it('is treated as an attachment by its excalidraw-plugin property, and a plain note is not', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: { waitUntil },
        pluginId
      }): Promise<PropertyProbeResult> {
        const ROOT = 'rdh-excalidraw-property';
        const PROPERTY_DRAWING = `${ROOT}/Drawing.md`;
        const COMPOUND_DRAWING = `${ROOT}/Sketch.excalidraw.md`;
        const PLAIN_NOTE = `${ROOT}/Note.md`;
        /*
         * Under the transport's ~30s per-closure cap, not at it. Two charges: the metadata cache parsing two
         * freshly created notes, which lands in well under a second.
         */
        const WAIT_TIMEOUT_IN_MILLISECONDS = 10_000;

        const apiRecord = (window as PluginApiRegistryHostLike).__obsidianDevUtils?.pluginApiRegistry?.value?.records?.[pluginId]
          ?.find((candidate) => !candidate.isRevoked);
        if (!apiRecord) {
          throw new Error(`${pluginId} has published no API`);
        }

        const api = apiRecord.api;

        try {
          await app.vault.createFolder(ROOT);
          const drawingFile = await app.vault.create(PROPERTY_DRAWING, '---\nexcalidraw-plugin: parsed\n---\n\n# Excalidraw Data\n');
          const noteFile = await app.vault.create(PLAIN_NOTE, '---\ntags: [plain]\n---\n\n# Note\n');
          await app.vault.create(COMPOUND_DRAWING, '# Excalidraw Data\n');

          /*
           * A `property:` entry answers "no match" until the cache has the file — the cold-cache rule — so the
           * assertions wait for Obsidian to have parsed the frontmatter of both notes rather than racing the indexer.
           */
          await waitUntil({
            message: 'the metadata cache parses the drawing\'s frontmatter',
            predicate: () => app.metadataCache.getFileCache(drawingFile)?.frontmatter?.['excalidraw-plugin'] !== undefined,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });
          await waitUntil({
            message: 'the metadata cache parses the note\'s frontmatter',
            predicate: () => app.metadataCache.getFileCache(noteFile)?.frontmatter?.['tags'] !== undefined,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          return {
            isCompoundExtensionDrawingAttachment: api.isTreatedAsAttachment(COMPOUND_DRAWING),
            isPlainNoteAttachment: api.isTreatedAsAttachment(PLAIN_NOTE),
            isPropertyDrawingAttachment: api.isTreatedAsAttachment(PROPERTY_DRAWING),
            treatAsAttachmentExtensions: [...api.getSettings().treatAsAttachmentExtensions]
          };
        } finally {
          if (await app.vault.adapter.exists(ROOT)) {
            await app.vault.adapter.rmdir(ROOT, true);
          }
        }
      },
      input: { pluginId: PLUGIN_ID }
    });

    // Asserted first, so a suite that left the list changed fails here, naming the cause, rather than below.
    expect(result.treatAsAttachmentExtensions).toEqual(['.excalidraw.md', 'property:excalidraw-plugin']);
    expect(result.isPropertyDrawingAttachment).toBe(true);
    expect(result.isCompoundExtensionDrawingAttachment).toBe(true);
    expect(result.isPlainNoteAttachment).toBe(false);
  });
});
