import type { PluginNoticeComponent } from '@mnaoumov/obsidian-lib/components/plugin-notice-component';
import type {
  App as AppOriginal,
  PluginManifest
} from 'obsidian';

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
import {
  MAX_LISTED_HITS,
  SettingsPathWarner
} from './settings-path-warner.ts';

// The mock app's own config folder, which these tests seed.
const CONFIG_DIR = App.createConfigured__().asOriginalType__().vault.configDir;
const RENAMES = new Map([['Templates', 'Meta/Templates']]);

let settings: PluginSettings;
let showNotice: ReturnType<typeof vi.fn>;

function createWarner(files: Record<string, string>, manifests: Record<string, Partial<PluginManifest>> = {}): SettingsPathWarner {
  const app: AppOriginal = App.createConfigured__({ files }).asOriginalType__();
  Object.assign(app.plugins, { manifests });

  return new SettingsPathWarner({
    app,
    pluginNoticeComponent: castTo<PluginNoticeComponent>({ showNotice }),
    pluginSettingsComponent: castTo<PluginSettingsComponent>({ settings })
  });
}

function getNoticeLines(): string[] {
  const container = createDiv();
  container.append(castTo<DocumentFragment>(ensureNonNullable(showNotice.mock.calls[0])[0]));
  return container.innerHTML.split('<br>');
}

beforeEach(() => {
  settings = new PluginSettings();
  settings.shouldWarnAboutPathsInSettings = true;
  showNotice = vi.fn();
});

describe('SettingsPathWarner', () => {
  it('should do nothing while the setting is off, or for an empty batch', async () => {
    const warner = createWarner({ [`${CONFIG_DIR}/templates.json`]: '{"folder":"Templates"}' });

    await warner.handleRenames(new Map());
    settings.shouldWarnAboutPathsInSettings = false;
    await warner.handleRenames(RENAMES);

    expect(showNotice).not.toHaveBeenCalled();
  });

  it('should name each stale setting in Obsidian\'s files and in plugins\' data, skipping the workspace', async () => {
    await createWarner({
      [`${CONFIG_DIR}/appearance.css`]: 'Templates',
      [`${CONFIG_DIR}/plugins/broken/data.json`]: '{not json',
      [`${CONFIG_DIR}/plugins/no-data/main.js`]: '',
      [`${CONFIG_DIR}/plugins/unknown/data.json`]: '"Templates"',
      [`${CONFIG_DIR}/plugins/watcher/data.json`]: '{"templates_folder":"Templates/Core"}',
      [`${CONFIG_DIR}/plugins/watcher/main.js`]: '',
      [`${CONFIG_DIR}/templates.json`]: '{"folder":"Templates"}',
      [`${CONFIG_DIR}/workspace-mobile.json`]: '{"lastOpen":"Templates/a.md"}',
      [`${CONFIG_DIR}/workspace.json`]: '{"lastOpen":"Templates/a.md"}'
    }, {
      'folder-watcher': {
        // eslint-disable-next-line unicorn/name-replacements -- Obsidian's own manifest field.
        dir: `${CONFIG_DIR}/plugins/watcher`,
        name: 'Folder Watcher'
      }
    }).handleRenames(RENAMES);

    expect(getNoticeLines()).toEqual([
      'Renamed paths are still named in settings. Update them there:',
      'Obsidian (templates.json): folder = Templates → Meta/Templates',
      'unknown: Templates → Meta/Templates',
      'Folder Watcher: templates_folder = Templates/Core → Meta/Templates/Core'
    ]);
  });

  it('should stay silent when no setting names a moved path, and cope with no plugins folder', async () => {
    await createWarner({ [`${CONFIG_DIR}/app.json`]: '{"attachmentFolderPath":"Assets"}' }).handleRenames(RENAMES);

    expect(showNotice).not.toHaveBeenCalled();
  });

  it('should list at most a page of hits and count the rest', async () => {
    await createWarner({
      [`${CONFIG_DIR}/many.json`]: JSON.stringify(Array.from({ length: MAX_LISTED_HITS + 2 }, () => 'Templates'))
    }).handleRenames(RENAMES);

    const lines = getNoticeLines();

    expect(lines).toHaveLength(MAX_LISTED_HITS + 2);
    expect(lines.at(-1)).toBe('…and 2 more.');
  });
});
