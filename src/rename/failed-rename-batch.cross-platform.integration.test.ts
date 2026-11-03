import { evalInObsidian } from 'obsidian-integration-testing';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { AdvancedRenameAndDeleteHandlerApi } from '../../api.d.ts';
import type { PluginSettingsSnapshot } from '../settings/settings-snapshot.integration-helper.ts';

import {
  readPluginSettings,
  writePluginSettings
} from '../settings/settings-snapshot.integration-helper.ts';

interface ApiRecord {
  readonly api: AdvancedRenameAndDeleteHandlerApi;
  readonly isRevoked: boolean;
}

interface BatchResult {
  readonly isOriginalError: boolean;
  readonly links: Record<string, (null | string)[]>;
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

let originalSettings: PluginSettingsSnapshot;
beforeAll(async () => {
  originalSettings = await readPluginSettings();
  await writePluginSettings({ ...originalSettings, shouldHandleRenames: true });
});
afterAll(async () => {
  await writePluginSettings(originalSettings);
});

describe('a failed rename batch', () => {
  it('finishes held backlinks and moved-note repairs before rejecting with the original error', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { flushQueue, waitUntil } }): Promise<BatchResult> {
        const api = (window as RegistryHost).__obsidianLib?.pluginApiRegistry?.value?.records?.['advanced-rename-and-delete-handler']?.find((record) => !record.isRevoked)?.api;
        if (!api) {
          throw new Error('No live rename-handler API.');
        }
        const root = 'failed-rename-batch';
        const originalError = new Error('deliberate callback failure');
        const WAIT_TIMEOUT_IN_MILLISECONDS = 10_000;
        const originalLinkFormat = app.vault.getConfig('newLinkFormat');
        try {
          app.vault.setConfig('newLinkFormat', 'relative');
          await app.vault.saveConfig();
          await app.vault.createFolder(`${root}/Source`);
          await app.vault.createFolder(`${root}/Alpha`);
          await app.vault.createFolder(`${root}/Bravo`);
          const alpha = await app.vault.create(`${root}/Source/Alpha.md`, '[Bravo](Bravo.md)');
          const bravo = await app.vault.create(`${root}/Source/Bravo.md`, '[Alpha](Alpha.md)');
          const holder = await app.vault.create(`${root}/Holder.md`, `[Alpha](${root}/Source/Alpha.md) [Bravo](${root}/Source/Bravo.md)`);
          await waitUntil({
            message: 'all initial links are indexed',
            predicate: () => [alpha, bravo, holder].every((file) => (app.metadataCache.getFileCache(file)?.links?.length ?? 0) > 0),
            timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
          });
          let isOriginalError = false;
          try {
            await api.runInBatch(async () => {
              await app.fileManager.renameFile(alpha, `${root}/Alpha/Alpha.md`);
              // The moved note's rewrite proves its handler began before we drain its held snapshot.
              await waitUntil({
                message: 'the first rename handler has rewritten its own link',
                predicate: async () => {
                  const content = await app.vault.read(alpha);
                  return content.includes('Source/Bravo');
                },
                timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
              });
              await flushQueue();
              await app.fileManager.renameFile(bravo, `${root}/Bravo/Bravo.md`);
              throw originalError;
            });
          } catch (error) {
            isOriginalError = error === originalError;
          }
          return {
            isOriginalError,
            links: Object.fromEntries([alpha, bravo, holder].map((file) => [file.path, (app.metadataCache.getFileCache(file)?.links ?? []).map((link) => app.metadataCache.getFirstLinkpathDest(link.link, file.path)?.path ?? null)]))
          };
        } finally {
          await flushQueue();
          app.vault.setConfig('newLinkFormat', originalLinkFormat);
          await app.vault.saveConfig();
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      }
    });
    expect(result.isOriginalError).toBe(true);
    expect(result.links).toEqual({
      'failed-rename-batch/Alpha/Alpha.md': ['failed-rename-batch/Bravo/Bravo.md'],
      'failed-rename-batch/Bravo/Bravo.md': ['failed-rename-batch/Alpha/Alpha.md'],
      'failed-rename-batch/Holder.md': ['failed-rename-batch/Alpha/Alpha.md', 'failed-rename-batch/Bravo/Bravo.md']
    });
  });
});
