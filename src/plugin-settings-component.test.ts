import type { App as AppOriginal } from 'obsidian';
import type { DataHandler } from 'obsidian-dev-utils/obsidian/data-handler';
import type { PluginEventSource } from 'obsidian-dev-utils/obsidian/plugin/plugin-event-source';
import type { Mock } from 'vitest';

import { noopAsync } from 'obsidian-dev-utils/function';
import { strictProxy } from 'obsidian-dev-utils/strict-proxy';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { PluginSettingsComponent } from './plugin-settings-component.ts';

let app: AppOriginal;
let saveData: Mock<DataHandler['saveData']>;

beforeEach(() => {
  app = App.createConfigured__().asOriginalType__();
  saveData = vi.fn<DataHandler['saveData']>(() => noopAsync());
});

function createComponent(): PluginSettingsComponent {
  return new PluginSettingsComponent({
    app,
    dataHandler: strictProxy<DataHandler>({}),
    pluginEventSource: strictProxy<PluginEventSource>({})
  });
}

async function loadComponent(data: unknown): Promise<PluginSettingsComponent> {
  return await loadComponentWith(vi.fn<() => Promise<unknown>>().mockResolvedValue(data));
}

async function loadComponentWith(loadData: () => Promise<unknown>): Promise<PluginSettingsComponent> {
  const component = new PluginSettingsComponent({
    app,
    dataHandler: strictProxy<DataHandler>({
      loadData,
      saveData
    }),
    pluginEventSource: strictProxy<PluginEventSource>({
      on: vi.fn().mockReturnValue({ asyncEventSource: { offref: vi.fn() } })
    })
  });
  await component.loadWithPromises();
  return component;
}

describe('PluginSettingsComponent', () => {
  it('should create default settings from the PluginSettings class', () => {
    const settings = createComponent().defaultSettings;

    expect(settings.shouldHandleRenames).toBe(false);
    expect(settings.treatAsAttachmentExtensions).toEqual(['.excalidraw.md']);
  });

  describe('ensureDataFileExists', () => {
    // Nothing changed since the read, so `saveToFile` would write nothing — which is why this exists.
    it('should write a data.json when there is none', async () => {
      const component = await loadComponent(null);

      await component.ensureDataFileExists();

      expect(saveData).toHaveBeenCalledWith({});
    });

    it('should leave an existing data.json alone, so a save that got there first is kept', async () => {
      const loadData = vi.fn<() => Promise<unknown>>().mockResolvedValue(null);
      const component = await loadComponentWith(loadData);
      loadData.mockResolvedValue({ shouldHandleRenames: true });

      await component.ensureDataFileExists();

      expect(saveData).not.toHaveBeenCalled();
    });
  });

  describe('wasDataFileMissingOnInitialLoad', () => {
    it('should be false before anything has been read', () => {
      expect(createComponent().wasDataFileMissingOnInitialLoad).toBe(false);
    });

    it('should be true when the first read finds no data.json', async () => {
      const component = await loadComponent(null);

      expect(component.wasDataFileMissingOnInitialLoad).toBe(true);
    });

    it('should be false when the first read finds settings', async () => {
      const component = await loadComponent({ shouldHandleRenames: true });

      expect(component.wasDataFileMissingOnInitialLoad).toBe(false);
      expect(component.settings.shouldHandleRenames).toBe(true);
    });

    // A later reload answers a different question — an external edit to `data.json` — and must not rewrite
    // What the first load found.
    it('should keep what the first load found across a later reload', async () => {
      const loadData = vi.fn<() => Promise<unknown>>().mockResolvedValue(null);
      const component = await loadComponentWith(loadData);
      loadData.mockResolvedValue({ shouldHandleRenames: true });

      await component.loadFromFile(false);

      expect(component.wasDataFileMissingOnInitialLoad).toBe(true);
    });
  });

  describe('isNoteEx', () => {
    it('should report a markdown file as a note', () => {
      expect(createComponent().isNoteEx('note.md')).toBe(true);
    });

    it('should reject a non-note file', () => {
      expect(createComponent().isNoteEx('image.png')).toBe(false);
    });

    it('should reject a null path', () => {
      expect(createComponent().isNoteEx(null)).toBe(false);
    });

    it('should reject a note whose extension is configured as an attachment', () => {
      /*
       * `.excalidraw.md` is a note by extension and a drawing by intent. Rejecting it is the whole reason
       * this method exists rather than calling the library's `isNote` directly.
       */
      expect(createComponent().isNoteEx('drawing.excalidraw.md')).toBe(false);
    });
  });
});
