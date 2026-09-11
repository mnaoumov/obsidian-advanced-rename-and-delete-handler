/**
 * @file
 *
 * Tells the user, once, that this plugin does nothing until they turn something on.
 *
 * The defaults are a no-op so that being asked to install this plugin — which the plugins depending on it do
 * — is harmless. That leaves one user it is not harmless for: someone on an older version, whose defaults
 * handled renames, who never changed a setting. Nothing of theirs is on disk to keep, so the upgrade quietly
 * switches their rename handling off, and they find out weeks later from a broken link. That is exactly the
 * failure the dependency mechanism was built to prevent, so it must not be reintroduced by the defaults that
 * make the mechanism acceptable.
 *
 * A first run cannot tell that user apart from a fresh install — both show up as a missing `data.json` — so it
 * tells both. Then it writes the file, which is what makes "once" true: the next load finds settings to read.
 */

import type { App } from 'obsidian';
import type { PluginNoticeComponent } from 'obsidian-dev-utils/obsidian/components/plugin-notice-component';

import { ComponentEx } from 'obsidian-dev-utils/obsidian/components/component-ex';

import type { PluginSettingsComponent } from './plugin-settings-component.ts';

interface FirstLoadNoticeComponentConstructorParams {
  readonly app: App;
  readonly pluginId: string;
  readonly pluginNoticeComponent: PluginNoticeComponent;
  readonly pluginSettingsComponent: PluginSettingsComponent;
}

export class FirstLoadNoticeComponent extends ComponentEx {
  private readonly app: App;
  private readonly pluginId: string;
  private readonly pluginNoticeComponent: PluginNoticeComponent;
  private readonly pluginSettingsComponent: PluginSettingsComponent;

  public constructor(params: FirstLoadNoticeComponentConstructorParams) {
    super();
    this.app = params.app;
    this.pluginId = params.pluginId;
    this.pluginNoticeComponent = params.pluginNoticeComponent;
    this.pluginSettingsComponent = params.pluginSettingsComponent;
  }

  public override async onloadAsync(): Promise<void> {
    await super.onloadAsync();

    // The flag is set by the settings component's first read, which is still in flight when this loads.
    await this.pluginSettingsComponent.whenLoadedFromFile();
    if (!this.pluginSettingsComponent.wasDataFileMissingOnInitialLoad) {
      return;
    }

    /*
     * Permanent: it has to survive the moment it appears, which on a cold start is before the user is looking,
     * and it is shown at most once per vault. The button is what a user acts on, and clicking it also dismisses
     * the notice.
     */
    this.pluginNoticeComponent.showNotice(this.createMessage(), { isPermanent: true });

    await this.pluginSettingsComponent.ensureDataFileExists();
  }

  private createMessage(): DocumentFragment {
    return createFragment((f) => {
      f.appendText('Installed, and doing nothing yet: renames and deletions stay with Obsidian until you turn on ');
      f.createEl('strong', { text: 'Should handle renames' });
      f.appendText(' or ');
      f.createEl('strong', { text: 'Should handle deletions' });
      f.appendText('.');
      f.createEl('br');
      f.appendText('If you used an earlier version and never changed its settings, rename handling used to be on. Turn it back on to keep it.');
      f.createEl('br');
      f.createEl('button', { text: 'Open settings' }, (buttonEl) => {
        buttonEl.addEventListener('click', () => {
          this.app.setting.open();
          this.app.setting.openTabById(this.pluginId);
        });
      });
    });
  }
}
