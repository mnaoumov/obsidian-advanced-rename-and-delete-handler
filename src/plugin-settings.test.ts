import { EmptyFolderBehavior } from 'obsidian-dev-utils/obsidian/components/rename-delete-handler-component';
import {
  describe,
  expect,
  it
} from 'vitest';

import { PluginSettings } from './plugin-settings.ts';

describe('PluginSettings', () => {
  describe('defaults', () => {
    it('should handle renames, which is the reason the plugin exists', () => {
      expect(new PluginSettings().shouldHandleRenames).toBe(true);
    });

    it('should update file name aliases', () => {
      expect(new PluginSettings().shouldUpdateFileNameAliases).toBe(true);
    });

    it('should rename the attachment folder but not the attachment files', () => {
      const settings = new PluginSettings();

      expect(settings.shouldRenameAttachmentFolder).toBe(true);
      expect(settings.shouldRenameAttachmentFiles).toBe(false);
    });

    it('should leave every destructive option off', () => {
      const settings = new PluginSettings();

      expect(settings.shouldHandleDeletions).toBe(false);
      expect(settings.shouldDeleteConflictingAttachments).toBe(false);
      expect(settings.shouldRescueSharedAttachments).toBe(false);
      expect(settings.emptyFolderBehavior).toBe(EmptyFolderBehavior.Keep);
    });

    it('should not have migrated legacy settings', () => {
      expect(new PluginSettings().hasMigratedLegacySettings).toBe(false);
    });

    it('should treat .excalidraw.md as an attachment', () => {
      expect(new PluginSettings().treatAsAttachmentExtensions).toEqual(['.excalidraw.md']);
    });

    it('should have an empty note priority list', () => {
      expect(new PluginSettings().notePriorities).toEqual([]);
    });

    it('should scope to the whole vault', () => {
      const settings = new PluginSettings();

      expect(settings.includePaths).toEqual([]);
      expect(settings.excludePaths).toEqual([]);
    });
  });

  describe('isPathIgnored', () => {
    it('should ignore nothing by default', () => {
      expect(new PluginSettings().isPathIgnored('any/path.md')).toBe(false);
    });

    it('should ignore an excluded path', () => {
      const settings = new PluginSettings();
      settings.excludePaths = ['secret'];

      expect(settings.isPathIgnored('secret/note.md')).toBe(true);
      expect(settings.isPathIgnored('other/note.md')).toBe(false);
    });

    it('should ignore everything outside the included paths', () => {
      const settings = new PluginSettings();
      settings.includePaths = ['notes'];

      expect(settings.isPathIgnored('notes/note.md')).toBe(false);
      expect(settings.isPathIgnored('elsewhere/note.md')).toBe(true);
    });

    it('should round-trip the path lists through their setters', () => {
      const settings = new PluginSettings();
      settings.excludePaths = ['a'];
      settings.includePaths = ['b'];

      expect(settings.excludePaths).toEqual(['a']);
      expect(settings.includePaths).toEqual(['b']);
    });
  });

  describe('isTreatedAsAttachment', () => {
    it('should treat a configured extension as an attachment', () => {
      expect(new PluginSettings().isTreatedAsAttachment('drawing.excalidraw.md')).toBe(true);
    });

    it('should leave an ordinary note alone', () => {
      expect(new PluginSettings().isTreatedAsAttachment('note.md')).toBe(false);
    });

    it('should honour a replaced extension list', () => {
      const settings = new PluginSettings();
      settings.treatAsAttachmentExtensions = ['.canvas.md'];

      expect(settings.isTreatedAsAttachment('board.canvas.md')).toBe(true);
      expect(settings.isTreatedAsAttachment('drawing.excalidraw.md')).toBe(false);
    });
  });
});
