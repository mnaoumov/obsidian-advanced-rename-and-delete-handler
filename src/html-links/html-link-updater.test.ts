import type { PluginNoticeComponent } from '@mnaoumov/obsidian-lib/components/plugin-notice-component';
import type { App as AppOriginal } from 'obsidian';

import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { PluginSettingsComponent } from '../settings/plugin-settings-component.ts';

import { PluginSettings } from '../settings/plugin-settings.ts';
import { HtmlLinkUpdater } from './html-link-updater.ts';

let app: AppOriginal;
let settings: PluginSettings;
let showNotice: ReturnType<typeof vi.fn>;

function createUpdater(files: Record<string, string>): HtmlLinkUpdater {
  app = App.createConfigured__({ files }).asOriginalType__();
  return new HtmlLinkUpdater({
    app,
    pluginNoticeComponent: castTo<PluginNoticeComponent>({ showNotice }),
    pluginSettingsComponent: castTo<PluginSettingsComponent>({ settings })
  });
}

async function read(path: string): Promise<string> {
  return await app.vault.read(ensureNonNullable(app.vault.getFileByPath(path)));
}

/**
 * Renames through the vault, the way the batch component sees it, and hands the updater the batch.
 *
 * @param updater - The updater.
 * @param renames - Old path to new path.
 */
async function renameAndHandle(updater: HtmlLinkUpdater, renames: Record<string, string>): Promise<void> {
  for (const [oldPath, newPath] of Object.entries(renames)) {
    await app.vault.rename(ensureNonNullable(app.vault.getAbstractFileByPath(oldPath)), newPath);
  }

  await updater.handleRenames(new Map(Object.entries(renames)));
}

beforeEach(() => {
  settings = new PluginSettings();
  settings.shouldUpdateHtmlLinks = true;
  showNotice = vi.fn();
});

describe('HtmlLinkUpdater', () => {
  it('should do nothing while the setting is off', async () => {
    settings.shouldUpdateHtmlLinks = false;
    const updater = createUpdater({ 'a.png': '', 'note.md': '<img src="a.png">' });

    await renameAndHandle(updater, { 'a.png': 'b.png' });

    expect(await read('note.md')).toBe('<img src="a.png">');
  });

  it('should do nothing for a batch that renamed only folders', async () => {
    const updater = createUpdater({ 'note.md': '<img src="old/a.png">', 'old/': '' });
    const cachedRead = vi.spyOn(app.vault, 'cachedRead');

    await renameAndHandle(updater, { old: 'new' });

    expect(cachedRead).not.toHaveBeenCalled();
  });

  it('should rewrite the notes naming a moved file and announce it', async () => {
    const updater = createUpdater({
      'a.png': '',
      'note.md': '<img src="a.png"> <img src="./a.png">',
      'other.md': '<img src="c.png">'
    });
    const process = vi.spyOn(app.vault, 'process');

    await renameAndHandle(updater, { 'a.png': 'b.png' });

    expect(await read('note.md')).toBe('<img src="b.png"> <img src="./b.png">');
    expect(process.mock.calls.map(([file]) => file.path)).toEqual(['note.md']);
    expect(showNotice).toHaveBeenCalledWith('Updated 2 HTML links in 1 file.');
  });

  it('should match a moved note by its name without .md', async () => {
    const updater = createUpdater({ 'note.md': '<a href="old">x</a>', 'old.md': '' });

    await renameAndHandle(updater, { 'old.md': 'new.md' });

    expect(await read('note.md')).toBe('<a href="new">x</a>');
  });

  it('should open a moved note even when it names nothing that moved', async () => {
    const updater = createUpdater({ 'folder/': '', 'note.md': '<img src="./x.png">', 'x.png': '' });

    await renameAndHandle(updater, { 'note.md': 'folder/note.md' });

    expect(await read('folder/note.md')).toBe('<img src="../x.png">');
  });

  it('should skip an ignored note', async () => {
    settings.excludePaths = ['ignored'];
    const updater = createUpdater({ 'a.png': '', 'ignored/note.md': '<img src="a.png">' });

    await renameAndHandle(updater, { 'a.png': 'b.png' });

    expect(await read('ignored/note.md')).toBe('<img src="a.png">');
  });

  it('should stay silent when nothing changed, or when the notice is off', async () => {
    const updater = createUpdater({
      'a.png': '',
      'c.png': '',
      'note.md': '<img src="unrelated/a.png">',
      'second.md': '<img src="c.png">',
      'unrelated/a.png': ''
    });

    await renameAndHandle(updater, { 'a.png': 'b.png' });

    expect(await read('note.md')).toBe('<img src="unrelated/a.png">');
    expect(showNotice).not.toHaveBeenCalled();

    settings.shouldShowLinkUpdateNotice = false;
    await renameAndHandle(updater, { 'c.png': 'd.png' });

    expect(await read('second.md')).toBe('<img src="d.png">');
    expect(showNotice).not.toHaveBeenCalled();
  });

  it('should read a note again only once it changed', async () => {
    const updater = createUpdater({ 'a.png': '', 'b.png': '', 'note.md': '<img src="a.png">' });
    const cachedRead = vi.spyOn(app.vault, 'cachedRead');

    await renameAndHandle(updater, { 'b.png': 'c.png' });
    await renameAndHandle(updater, { 'c.png': 'd.png' });

    expect(cachedRead).toHaveBeenCalledOnce();

    await app.vault.modify(ensureNonNullable(app.vault.getFileByPath('note.md')), '<img src="a.png"> <img src="d.png">');
    await renameAndHandle(updater, { 'd.png': 'e.png' });

    expect(cachedRead).toHaveBeenCalledTimes(2);
    expect(await read('note.md')).toBe('<img src="a.png"> <img src="e.png">');
  });
});
