import type { App as AppOriginal } from 'obsidian';
import type { PluginNoticeComponent } from 'obsidian-dev-utils/obsidian/components/plugin-notice-component';
import type { Mock } from 'vitest';

import { noopAsync } from 'obsidian-dev-utils/function';
import { castTo } from 'obsidian-dev-utils/object-utils';
import { strictProxy } from 'obsidian-dev-utils/strict-proxy';
import { ensureNonNullable } from 'obsidian-dev-utils/type-guards';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { PluginSettingsComponent } from './plugin-settings-component.ts';

import { FirstLoadNoticeComponent } from './first-load-notice-component.ts';

const PLUGIN_ID = 'advanced-rename-and-delete-handler';

interface AppSettingLike {
  open: ReturnType<typeof vi.fn>;
  openTabById: ReturnType<typeof vi.fn>;
}

// `app.setting` is the one member the notice reaches that obsidian-test-mocks does not model.
interface SettingLike {
  setting: AppSettingLike;
}

let app: AppOriginal;
let ensureDataFileExists: Mock<PluginSettingsComponent['ensureDataFileExists']>;
let showNotice: Mock<PluginNoticeComponent['showNotice']>;

beforeEach(() => {
  app = App.createConfigured__().asOriginalType__();
  castTo<SettingLike>(app).setting = {
    open: vi.fn(),
    openTabById: vi.fn()
  };
  ensureDataFileExists = vi.fn<PluginSettingsComponent['ensureDataFileExists']>(() => noopAsync());
  showNotice = vi.fn<PluginNoticeComponent['showNotice']>();
});

describe('FirstLoadNoticeComponent', () => {
  describe('when the first read found no data.json', () => {
    it('should say the plugin does nothing until something is turned on', async () => {
      await loadComponent(true);

      expect(showNotice).toHaveBeenCalledOnce();
      expect(noticeMessage().textContent).toContain('doing nothing yet');
      expect(showNotice).toHaveBeenCalledWith(expect.anything(), { isPermanent: true });
    });

    // A user upgrading from a version whose defaults handled renames, who never changed a setting, is the
    // Reason the notice exists — so it has to speak to them, not only to a fresh install.
    it('should tell an upgrading user that rename handling used to be on', async () => {
      await loadComponent(true);

      expect(noticeMessage().textContent).toContain('rename handling used to be on');
    });

    it('should leave a data.json behind, so the next load finds a file and stays quiet', async () => {
      await loadComponent(true);

      expect(ensureDataFileExists).toHaveBeenCalledOnce();
    });

    it('should open this plugin\'s settings from its button', async () => {
      await loadComponent(true);

      ensureNonNullable(noticeMessage().querySelector('button')).click();

      const setting = castTo<SettingLike>(app).setting;
      expect(setting.open).toHaveBeenCalledOnce();
      expect(setting.openTabById).toHaveBeenCalledWith(PLUGIN_ID);
    });
  });

  describe('when the first read found a data.json', () => {
    it('should neither show a notice nor save', async () => {
      await loadComponent(false);

      expect(showNotice).not.toHaveBeenCalled();
      expect(ensureDataFileExists).not.toHaveBeenCalled();
    });
  });
});

async function loadComponent(wasDataFileMissingOnInitialLoad: boolean): Promise<void> {
  const component = new FirstLoadNoticeComponent({
    app,
    pluginId: PLUGIN_ID,
    pluginNoticeComponent: strictProxy<PluginNoticeComponent>({ showNotice }),
    pluginSettingsComponent: strictProxy<PluginSettingsComponent>({
      ensureDataFileExists,
      wasDataFileMissingOnInitialLoad,
      whenLoadedFromFile: () => noopAsync()
    })
  });
  await component.loadWithPromises();
}

function noticeMessage(): DocumentFragment {
  return castTo<DocumentFragment>(ensureNonNullable(showNotice.mock.calls[0])[0]);
}
