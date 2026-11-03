import { evalInObsidian } from 'obsidian-integration-testing';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type {
  AdvancedRenameAndDeleteHandlerApi,
  BulkOperation,
  BulkOperationEvent
} from '../../api.d.ts';
import type { PluginSettingsSnapshot } from '../settings/settings-snapshot.integration-helper.ts';

import {
  readPluginSettings,
  writePluginSettings
} from '../settings/settings-snapshot.integration-helper.ts';

let originalSettings: PluginSettingsSnapshot;
beforeAll(async () => {
  originalSettings = await readPluginSettings();
  await writePluginSettings({ ...originalSettings, shouldHandleRenames: true });
});
afterAll(async () => {
  await writePluginSettings(originalSettings);
});

interface ApiRecord {
  readonly api: AdvancedRenameAndDeleteHandlerApi;
  readonly apiVersion: string;
  readonly isRevoked: boolean;
}

interface LifecycleResult {
  readonly observations: Observation[];
  readonly version: string;
}

interface Observation {
  readonly notification: BulkOperationEvent;
  readonly resolvedPath: null | string;
}

interface RegistryHost {
  readonly __obsidianLib?: RegistryState;
}

interface RegistryRecords {
  readonly records?: Readonly<Record<string, readonly ApiRecord[] | undefined>>;
}

interface RegistryState {
  readonly pluginApiRegistry?: RegistryWrapper;
}

interface RegistryWrapper {
  readonly value?: RegistryRecords;
}

describe('published bulk lifecycle', () => {
  it.each(['moveMany', 'runInBatch'] as const)('announces %s before changes and after final indexed links, including failure', async (operation: BulkOperation) => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil }, operation: mode }): Promise<LifecycleResult> {
        const record = (window as RegistryHost).__obsidianLib?.pluginApiRegistry?.value?.records?.['advanced-rename-and-delete-handler']?.find((entry) => !entry.isRevoked);
        if (!record) {
          throw new Error('No live rename-handler API.');
        }
        const root = `bulk-lifecycle-${mode}`;
        const oldPath = `${root}/Before.md`;
        const newPath = `${root}/After.md`;
        const holderPath = `${root}/Holder.md`;
        const observations: Observation[] = [];
        let unsubscribe: (() => void) | undefined;
        try {
          await app.vault.createFolder(root);
          const note = await app.vault.create(oldPath, 'Target');
          const unlinkedNote = await app.vault.create(`${root}/Unlinked.md`, 'A partial move may survive failure.');
          const holder = await app.vault.create(holderPath, '[[Before]]');
          function resolveHolder(): null | string {
            const link = app.metadataCache.getFileCache(holder)?.links?.[0];
            return link ? app.metadataCache.getFirstLinkpathDest(link.link, holder.path)?.path ?? null : null;
          }
          const INDEX_TIMEOUT_IN_MILLISECONDS = 10_000;
          await waitUntil({ message: 'the initial holder link resolves', predicate: () => resolveHolder() === oldPath, timeoutInMilliseconds: INDEX_TIMEOUT_IN_MILLISECONDS });
          unsubscribe = record.api.subscribeBulkOperations((notification) => {
            observations.push({ notification, resolvedPath: resolveHolder() });
          });
          if (mode === 'moveMany') {
            await record.api.moveMany({ moves: [{ newPath, oldPath }] });
          } else {
            await record.api.runInBatch(async () => {
              await app.fileManager.renameFile(note, newPath);
            });
          }
          // Failure still has a paired end. runInBatch fails after a real rename, so queued work must settle too.
          try {
            if (mode === 'moveMany') {
              await record.api.moveMany({ moves: [{ newPath: oldPath, oldPath: `${root}/Missing.md` }] });
            } else {
              await record.api.runInBatch(async () => {
                await app.fileManager.renameFile(unlinkedNote, `${root}/Partial.md`);
                throw new Error('deliberate batch failure');
              });
            }
          } catch {
            return { observations, version: record.apiVersion };
          }
          throw new Error('The failing operation unexpectedly succeeded.');
        } finally {
          unsubscribe?.();
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      },
      input: { operation }
    });
    expect(result.version).toBe('1.4.0');
    expect(result.observations).toEqual([
      { notification: { operation, phase: 'start' }, resolvedPath: `bulk-lifecycle-${operation}/Before.md` },
      { notification: { isSuccessful: true, operation, phase: 'end' }, resolvedPath: `bulk-lifecycle-${operation}/After.md` },
      { notification: { operation, phase: 'start' }, resolvedPath: `bulk-lifecycle-${operation}/After.md` },
      { notification: { isSuccessful: false, operation, phase: 'end' }, resolvedPath: `bulk-lifecycle-${operation}/After.md` }
    ]);
  });
});
