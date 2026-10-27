import type { Plugin } from 'obsidian';

import { evalInObsidian } from 'obsidian-integration-testing';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { PluginSettingsSnapshot } from '../settings/settings-snapshot.integration-helper.ts';

import {
  readPluginSettings,
  writePluginSettings
} from '../settings/settings-snapshot.integration-helper.ts';

/*
 * Some attachments are really a directory tree rather than a file: a page saved from a browser sits next
 * to a `_files/` folder, an `.excalidraw` next to the images it references. An attachment-location plugin
 * lets the user designate such folders as attachment units, and publishes that designation on its plugin API.
 *
 * Rescuing the lone linked file out of a deleted note's area tears the unit apart, and the attachment
 * arrives at the surviving note broken. See
 * https://github.com/mnaoumov/obsidian-custom-attachment-location/issues/70.
 *
 * Two cases, and they pull in opposite directions:
 *
 * - The whole folder travels, siblings and all, when it can.
 * - NOTHING travels when the folder cannot — a unit already sitting at its destination must not have its
 *   linked file pulled out of it into the folder above, which is the same tearing seen from the other end.
 *
 * The designation is staged by publishing a stub `Custom Attachment Location` API record, the same stand-in
 * the performance suite uses for that plugin's resolver, so this proves the plugin's half without installing
 * the plugin that publishes it. The stub's resolver answers the way Obsidian's own `./assets` setting would,
 * because publishing the API also hands it every attachment-path question.
 *
 * `alwaysUpdateLinks` is on because the rescue moves files through `app.fileManager.renameFile`, and
 * Obsidian would otherwise raise its own confirmation modal, which a headless run cannot answer.
 *
 * Cross-platform: a designated folder is designated on a phone too, and the manifest declares
 * `isDesktopOnly: false`.
 */

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_PLUGIN_ID = 'obsidian-custom-attachment-location';

/**
 * The fields of the attachment-path question `@mnaoumov/obsidian-lib` puts to `Custom Attachment Location`'s
 * API that the stub reads.
 */
interface AttachmentPathParamsLike {
  readonly attachmentFileBaseName: string;
  readonly attachmentFileExtension: string;
  readonly notePathOrFile: NotePathOrFileLike;
}

/**
 * The question `@mnaoumov/obsidian-lib` puts to `Custom Attachment Location`'s `isAttachmentUnitFolder`.
 */
interface IsAttachmentUnitFolderParamsLike {
  readonly folderPath: string;
}

interface MigratableSettingsLike {
  readonly shouldHandleDeletions?: boolean;
  readonly shouldHandleRenames?: boolean;
  readonly shouldRescueSharedAttachments?: boolean;
}

interface MigrateSettingsParamsLike {
  readonly proposedSettings: MigratableSettingsLike;
  readonly sourcePluginId: string;
}

interface MigrateSettingsResultLike {
  readonly isApplied: boolean;
}

interface MigrationApiLike {
  readonly migrateSettings: (params: MigrateSettingsParamsLike) => Promise<MigrateSettingsResultLike>;
}

/**
 * A note, named by its path or by a file that carries one.
 */
type NotePathOrFileLike = null | PathHolderLike | string;

interface ObsidianLibStateLike {
  readonly pluginApiRegistry?: PluginApiRegistryWrapperLike;
}

/**
 * Anything that carries a vault path, such as a `TFile`.
 */
interface PathHolderLike {
  readonly path: string;
}

/**
 * The slice of the `@mnaoumov/obsidian-lib` cross-plugin registry a closure reads the API from: the wire-level path
 * that library's Plugin API protocol guide freezes, so a suite reaches the plugin the way a consumer does.
 */
interface PluginApiRegistryHostLike {
  readonly __obsidianLib?: ObsidianLibStateLike;
}

interface PluginApiRegistryLike {
  readonly records?: Partial<Record<string, readonly PublishedPluginApiRecordLike[]>>;
}

interface PluginApiRegistryWrapperLike {
  readonly value?: PluginApiRegistryLike;
}

interface PublishedPluginApiRecordLike {
  readonly api: MigrationApiLike;
  readonly isRevoked: boolean;
}

interface UnitFolderKeptInPlaceResult {
  readonly doesLinkedFileStillSitInsideTheUnit: boolean;
  readonly doesSiblingStillSitInsideTheUnit: boolean;
  readonly wasLinkedFilePulledOutOfTheUnit: boolean;
}

interface UnitFolderRescueResult {
  readonly doesDeletedFolderStillExist: boolean;
  readonly rescuedLinkedFilePath: null | string;
  readonly rescuedSiblingPath: null | string;
  readonly survivorContent: string;
}

/*
 * This plugin's settings outlive each test file — one run drives every suite against one Obsidian instance —
 * so what this suite stages must not become the starting point of whichever file the sequencer runs next.
 * Handed back the way the `finally` blocks below hand back `attachmentFolderPath`. See
 * `settings-snapshot.integration-helper.ts`.
 */
let originalSettings: PluginSettingsSnapshot;

beforeAll(async () => {
  originalSettings = await readPluginSettings();
});

afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('Deleting a folder whose attachment belongs to an attachment unit folder', () => {
  it('moves the whole unit folder into the surviving note\'s area, siblings and all', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          castTo,
          ComponentEx,
          flushQueue,
          publishPluginApi,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<UnitFolderRescueResult> {
        const ROOT = 'rdh-unit-rescue';
        const DELETED_FOLDER = `${ROOT}/deleted`;
        const OWNER = `${DELETED_FOLDER}/Owner.md`;
        const UNIT_FOLDER = `${DELETED_FOLDER}/assets/drawing_files`;
        const LINKED_FILE = `${UNIT_FOLDER}/image.png`;
        const SIBLING = `${UNIT_FOLDER}/style.css`;
        const SURVIVOR = `${ROOT}/a/A.md`;
        const RESCUED_UNIT_FOLDER = `${ROOT}/a/assets/drawing_files`;
        /*
         * Under the transport's ~30s per-closure cap, not at it. This closure's declared waits SUM to under
         * the cap rather than each one sitting AT it: at 30_000 the ceiling was unreachable, because the eval
         * is killed at the cap first and reported as a bare transport timeout naming the harness rather than
         * the wait that actually overran. A helper's budget is charged once per CALL SITE, so the number
         * below is the whole closure's allowance divided by how many times it actually runs. What is waited
         * on here lands in well under a second, so a budget this size costs nothing — a wait that can
         * genuinely run long belongs in `pollInObsidian`, with Node doing the waiting, as the two note-move
         * suites here now do.
         */
        const WAIT_TIMEOUT_IN_MILLISECONDS = 12_000;
        const EXPECTED_BACKLINK_COUNT = 2;

        const apiRecord = (window as PluginApiRegistryHostLike).__obsidianLib?.pluginApiRegistry?.value?.records?.[pluginId]
          ?.find((candidate) => !candidate.isRevoked);
        if (!apiRecord) {
          throw new Error(`${pluginId} has published no API`);
        }

        const api = apiRecord.api;

        /**
         * Writes settings through the plugin's own migration API and approves the dialog it raises.
         *
         * @param proposedSettings - The settings to write.
         */
        async function applySettings(proposedSettings: MigratableSettingsLike): Promise<void> {
          const migrationPromise = api.migrateSettings({
            proposedSettings,
            sourcePluginId
          });
          let isSettled = false;
          const settlementPromise = migrationPromise
            .then(() => {
              isSettled = true;
            })
            .catch(() => {
              isSettled = true;
            });

          await waitUntil({
            message: 'the settings dialog opens, or the proposal turns out to change nothing',
            predicate: () => isSettled || document.querySelector('.modal-container') !== null,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const modalEl = document.querySelector('.modal-container');
          if (modalEl) {
            const okButton = [...modalEl.querySelectorAll('button')].find((button) => button.textContent === 'OK');
            if (!okButton) {
              throw new Error('the settings dialog has no OK button');
            }

            okButton.click();
          }

          await settlementPromise;
          const migrateSettingsResult = await migrationPromise;
          if (!migrateSettingsResult.isApplied) {
            throw new Error('the settings were not applied');
          }
        }

        const attachmentLocationStubOwner = new ComponentEx();

        /**
         * Publishes the stub `Custom Attachment Location` API: `_files` folders are attachment units, and every
         * note's attachments go to an `assets` folder beside it, as Obsidian's own `./assets` setting puts them.
         * Unloading {@link attachmentLocationStubOwner} revokes it.
         */
        function publishAttachmentLocationStub(): void {
          attachmentLocationStubOwner.load();
          publishPluginApi({
            api: {
              /*
               * Synchronous on purpose: the library awaits whatever the API returns, and this stub has nothing to
               * wait for.
               */
              getAvailablePathForAttachments: (params: AttachmentPathParamsLike): string => {
                const notePath = typeof params.notePathOrFile === 'string' ? params.notePathOrFile : params.notePathOrFile?.path ?? '';
                const noteFolderPath = notePath.split('/').slice(0, -1).join('/');
                const extension = params.attachmentFileExtension ? `.${params.attachmentFileExtension}` : '';
                return `${noteFolderPath}/assets/${params.attachmentFileBaseName}${extension}`;
              },
              isAttachmentUnitFolder: ({ folderPath }: IsAttachmentUnitFolderParamsLike): boolean => folderPath.endsWith('_files')
            },
            apiVersion: '1.3.0',
            component: attachmentLocationStubOwner,
            plugin: castTo<Plugin>({ manifest: { id: sourcePluginId } })
          });
        }

        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');
        const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');

        try {
          app.vault.setConfig('alwaysUpdateLinks', true);
          // A subfolder of each note's OWN folder, so the deleted note and the survivor resolve differently.
          app.vault.setConfig('attachmentFolderPath', './assets');
          // Saved at once, so a reload of `app.json` mid-case cannot put back a folder the handler would then look for in vain.
          await app.vault.saveConfig();

          /*
           * Stands in for an installed `Custom Attachment Location`: the designation is a member of its
           * published API, and no API is what a plain vault answers.
           */
          publishAttachmentLocationStub();

          await applySettings({
            shouldHandleDeletions: true,
            shouldHandleRenames: true,
            shouldRescueSharedAttachments: true
          });

          await app.vault.createFolder(UNIT_FOLDER);
          await app.vault.createFolder(`${ROOT}/a`);
          const linkedFile = await app.vault.createBinary(LINKED_FILE, new ArrayBuffer(8));
          // Referenced by nothing: it survives only because the unit it belongs to travels whole.
          await app.vault.create(SIBLING, 'body { color: red; }\n');
          await app.vault.create(OWNER, `![[${LINKED_FILE}]]\n`);
          await app.vault.create(SURVIVOR, `![[${LINKED_FILE}]]\n`);

          await waitUntil({
            message: 'both references to the linked file are indexed',
            predicate: () => app.metadataCache.getBacklinksForFile(linkedFile).keys().length === EXPECTED_BACKLINK_COUNT,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const deletedFolder = app.vault.getFolderByPath(DELETED_FOLDER);
          if (!deletedFolder) {
            throw new Error(`${DELETED_FOLDER} was not created`);
          }

          await app.fileManager.trashFile(deletedFolder);

          // The owning note's own deletion is reported after the replay and re-walks its links.
          await flushQueue();

          const survivorFile = app.vault.getFileByPath(SURVIVOR);
          if (!survivorFile) {
            throw new Error(`${SURVIVOR} disappeared`);
          }

          return {
            doesDeletedFolderStillExist: app.vault.getFolderByPath(DELETED_FOLDER) !== null,
            rescuedLinkedFilePath: app.vault.getFileByPath(`${RESCUED_UNIT_FOLDER}/image.png`)?.path ?? null,
            rescuedSiblingPath: app.vault.getFileByPath(`${RESCUED_UNIT_FOLDER}/style.css`)?.path ?? null,
            survivorContent: await app.vault.read(survivorFile)
          };
        } finally {
          attachmentLocationStubOwner.unload();
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
          // Saved at once, so a reload of `app.json` before the debounced save cannot hand the next suite this case's folder.
          await app.vault.saveConfig();
          /*
           * Through the adapter: a fixture teardown must not travel back through the very delete path this
           * plugin patches, which would make the cleanup part of what is under test.
           */
          if (await app.vault.adapter.exists(ROOT)) {
            await app.vault.adapter.rmdir(ROOT, true);
          }
        }
      },
      input: {
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    // The linked file arrived, still inside its unit folder rather than beside it.
    expect(result.rescuedLinkedFilePath).toBe('rdh-unit-rescue/a/assets/drawing_files/image.png');

    // And so did the sibling nothing referenced, which the lone-file rescue used to leave to be deleted.
    expect(result.rescuedSiblingPath).toBe('rdh-unit-rescue/a/assets/drawing_files/style.css');

    /*
     * The surviving note's link followed the move. Asserted as "no longer names the deleted folder" rather
     * than by the new path: with the attachment now unique in the vault, Obsidian rewrites the link in its
     * shortest form, which names no folder at all.
     */
    expect(result.survivorContent).not.toContain('rdh-unit-rescue/deleted');

    // Nothing was left holding the folder the user asked to delete open.
    expect(result.doesDeletedFolderStillExist).toBe(false);
  });

  it('leaves the attachment inside a unit folder that already sits where the rescue would put it', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        lib: {
          castTo,
          ComponentEx,
          flushQueue,
          publishPluginApi,
          waitUntil
        },
        pluginId,
        sourcePluginId
      }): Promise<UnitFolderKeptInPlaceResult> {
        const ROOT = 'rdh-unit-in-place';
        const DELETED_FOLDER = `${ROOT}/deleted`;
        const OWNER = `${DELETED_FOLDER}/Owner.md`;
        const SURVIVOR = `${ROOT}/a/A.md`;
        const UNIT_FOLDER = `${ROOT}/a/assets/drawing_files`;
        const LINKED_FILE = `${UNIT_FOLDER}/image.png`;
        const SIBLING = `${UNIT_FOLDER}/style.css`;
        const PULLED_OUT_FILE = `${ROOT}/a/assets/image.png`;
        /*
         * Under the transport's ~30s per-closure cap, not at it. This closure's declared waits SUM to under
         * the cap rather than each one sitting AT it: at 30_000 the ceiling was unreachable, because the eval
         * is killed at the cap first and reported as a bare transport timeout naming the harness rather than
         * the wait that actually overran. A helper's budget is charged once per CALL SITE, so the number
         * below is the whole closure's allowance divided by how many times it actually runs. What is waited
         * on here lands in well under a second, so a budget this size costs nothing — a wait that can
         * genuinely run long belongs in `pollInObsidian`, with Node doing the waiting, as the two note-move
         * suites here now do.
         */
        const WAIT_TIMEOUT_IN_MILLISECONDS = 12_000;
        const EXPECTED_BACKLINK_COUNT = 2;

        const apiRecord = (window as PluginApiRegistryHostLike).__obsidianLib?.pluginApiRegistry?.value?.records?.[pluginId]
          ?.find((candidate) => !candidate.isRevoked);
        if (!apiRecord) {
          throw new Error(`${pluginId} has published no API`);
        }

        const api = apiRecord.api;

        /**
         * Writes settings through the plugin's own migration API and approves the dialog it raises.
         *
         * @param proposedSettings - The settings to write.
         */
        async function applySettings(proposedSettings: MigratableSettingsLike): Promise<void> {
          const migrationPromise = api.migrateSettings({
            proposedSettings,
            sourcePluginId
          });
          let isSettled = false;
          const settlementPromise = migrationPromise
            .then(() => {
              isSettled = true;
            })
            .catch(() => {
              isSettled = true;
            });

          await waitUntil({
            message: 'the settings dialog opens, or the proposal turns out to change nothing',
            predicate: () => isSettled || document.querySelector('.modal-container') !== null,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const modalEl = document.querySelector('.modal-container');
          if (modalEl) {
            const okButton = [...modalEl.querySelectorAll('button')].find((button) => button.textContent === 'OK');
            if (!okButton) {
              throw new Error('the settings dialog has no OK button');
            }

            okButton.click();
          }

          await settlementPromise;
          const migrateSettingsResult = await migrationPromise;
          if (!migrateSettingsResult.isApplied) {
            throw new Error('the settings were not applied');
          }
        }

        const attachmentLocationStubOwner = new ComponentEx();

        /**
         * Publishes the stub `Custom Attachment Location` API: `_files` folders are attachment units, and every
         * note's attachments go to an `assets` folder beside it, as Obsidian's own `./assets` setting puts them.
         * Unloading {@link attachmentLocationStubOwner} revokes it.
         */
        function publishAttachmentLocationStub(): void {
          attachmentLocationStubOwner.load();
          publishPluginApi({
            api: {
              /*
               * Synchronous on purpose: the library awaits whatever the API returns, and this stub has nothing to
               * wait for.
               */
              getAvailablePathForAttachments: (params: AttachmentPathParamsLike): string => {
                const notePath = typeof params.notePathOrFile === 'string' ? params.notePathOrFile : params.notePathOrFile?.path ?? '';
                const noteFolderPath = notePath.split('/').slice(0, -1).join('/');
                const extension = params.attachmentFileExtension ? `.${params.attachmentFileExtension}` : '';
                return `${noteFolderPath}/assets/${params.attachmentFileBaseName}${extension}`;
              },
              isAttachmentUnitFolder: ({ folderPath }: IsAttachmentUnitFolderParamsLike): boolean => folderPath.endsWith('_files')
            },
            apiVersion: '1.3.0',
            component: attachmentLocationStubOwner,
            plugin: castTo<Plugin>({ manifest: { id: sourcePluginId } })
          });
        }

        const originalAlwaysUpdateLinks = app.vault.getConfig('alwaysUpdateLinks');
        const originalAttachmentFolderPath = app.vault.getConfig('attachmentFolderPath');

        try {
          app.vault.setConfig('alwaysUpdateLinks', true);
          app.vault.setConfig('attachmentFolderPath', './assets');
          // Saved at once, so a reload of `app.json` mid-case cannot put back a folder the handler would then look for in vain.
          await app.vault.saveConfig();

          publishAttachmentLocationStub();

          await applySettings({
            shouldHandleDeletions: true,
            shouldHandleRenames: true,
            shouldRescueSharedAttachments: true
          });

          await app.vault.createFolder(UNIT_FOLDER);
          await app.vault.createFolder(DELETED_FOLDER);
          const linkedFile = await app.vault.createBinary(LINKED_FILE, new ArrayBuffer(8));
          await app.vault.create(SIBLING, 'body { color: red; }\n');
          await app.vault.create(OWNER, `![[${LINKED_FILE}]]\n`);
          await app.vault.create(SURVIVOR, `![[${LINKED_FILE}]]\n`);

          await waitUntil({
            message: 'both references to the linked file are indexed',
            predicate: () => app.metadataCache.getBacklinksForFile(linkedFile).keys().length === EXPECTED_BACKLINK_COUNT,
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });

          const deletedFolder = app.vault.getFolderByPath(DELETED_FOLDER);
          if (!deletedFolder) {
            throw new Error(`${DELETED_FOLDER} was not created`);
          }

          await app.fileManager.trashFile(deletedFolder);
          await flushQueue();

          return {
            doesLinkedFileStillSitInsideTheUnit: app.vault.getFileByPath(LINKED_FILE) !== null,
            doesSiblingStillSitInsideTheUnit: app.vault.getFileByPath(SIBLING) !== null,
            wasLinkedFilePulledOutOfTheUnit: app.vault.getFileByPath(PULLED_OUT_FILE) !== null
          };
        } finally {
          attachmentLocationStubOwner.unload();
          app.vault.setConfig('alwaysUpdateLinks', originalAlwaysUpdateLinks);
          app.vault.setConfig('attachmentFolderPath', originalAttachmentFolderPath);
          // Saved at once, so a reload of `app.json` before the debounced save cannot hand the next suite this case's folder.
          await app.vault.saveConfig();
          if (await app.vault.adapter.exists(ROOT)) {
            await app.vault.adapter.rmdir(ROOT, true);
          }
        }
      },
      input: {
        pluginId: PLUGIN_ID,
        sourcePluginId: SOURCE_PLUGIN_ID
      }
    });

    /*
     * The rescue's own answer for the lone file is the folder ABOVE the unit — which is precisely where it
     * must not go. A unit that is already home stays whole and untouched.
     */
    expect(result.wasLinkedFilePulledOutOfTheUnit).toBe(false);
    expect(result.doesLinkedFileStillSitInsideTheUnit).toBe(true);
    expect(result.doesSiblingStillSitInsideTheUnit).toBe(true);
  });
});
