import type { App as AppOriginal } from 'obsidian';
import type { DataHandler } from 'obsidian-dev-utils/obsidian/data-handler';
import type { PluginEventSource } from 'obsidian-dev-utils/obsidian/plugin/plugin-event-source';

import { strictProxy } from 'obsidian-dev-utils/strict-proxy';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it
} from 'vitest';

import { PluginSettingsComponent } from './plugin-settings-component.ts';

let app: AppOriginal;

beforeEach(() => {
  app = App.createConfigured__().asOriginalType__();
});

function createComponent(): PluginSettingsComponent {
  return new PluginSettingsComponent({
    app,
    dataHandler: strictProxy<DataHandler>({}),
    pluginEventSource: strictProxy<PluginEventSource>({})
  });
}

describe('PluginSettingsComponent', () => {
  it('should create default settings from the PluginSettings class', () => {
    const settings = createComponent().defaultSettings;

    expect(settings.shouldHandleRenames).toBe(true);
    expect(settings.treatAsAttachmentExtensions).toEqual(['.excalidraw.md']);
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
