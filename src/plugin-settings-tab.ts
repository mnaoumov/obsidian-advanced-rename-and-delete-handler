import type { SettingDefinitionItem } from 'obsidian';

import { appendCodeBlock } from 'obsidian-dev-utils/obsidian/html-element';
import { PluginSettingsTabBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-settings-tab';

import type { PluginSettings } from './plugin-settings.ts';

import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';

export class PluginSettingsTab extends PluginSettingsTabBase<PluginSettings> {
  protected override getSettingDefinitionItems(): SettingDefinitionItem[] {
    return [
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText('Whether to handle renames and moves at all.');
          f.createEl('br');
          f.appendText('When enabled, this plugin updates the links pointing at a renamed or moved file, replacing Obsidian\'s own link update.');
          f.createEl('br');
          f.appendText('When disabled, Obsidian handles renames on its own and nothing below has any effect.');
        }),
        name: 'Should handle renames',
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldHandleRenames',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: 'Whether renaming a note also rewrites the display text of the links that pointed at its old name.',
        name: 'Should update file name aliases',
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldUpdateFileNameAliases',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: 'Whether renaming a note also renames or moves its attachment folder alongside it.',
        name: 'Should rename attachment folder',
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldRenameAttachmentFolder',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: 'Whether renaming a note also renames the attachment files that travel with it, so their names keep matching the note.',
        name: 'Should rename attachment files',
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldRenameAttachmentFiles',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText('Whether an attachment that collides with an existing file at the destination replaces it.');
          f.createEl('br');
          f.appendText('⚠️ This deletes the file already at the destination. When disabled, the moved attachment is renamed instead.');
        }),
        name: 'Should delete conflicting attachments',
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldDeleteConflictingAttachments',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText('Whether deleting a note also deletes the attachments only that note referenced.');
          f.createEl('br');
          f.appendText('⚠️ An attachment still referenced by another note is never deleted, but everything else the note owned is.');
        }),
        name: 'Should handle deletions',
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldHandleDeletions',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: 'What to do with a folder that a deletion or a move has left empty.',
        name: 'Empty folder behavior',
        render: (setting) => {
          setting.addDropdown((dropdown) => {
            dropdown.addOptions({
              /* eslint-disable perfectionist/sort-objects -- Need to keep enum order. */
              [EmptyFolderBehavior.Keep]: 'Keep',
              [EmptyFolderBehavior.Delete]: 'Delete',
              [EmptyFolderBehavior.DeleteWithEmptyParents]: 'Delete with empty parents'
              /* eslint-enable perfectionist/sort-objects -- Need to keep enum order. */
            });
            this.bind({
              propertyName: 'emptyFolderBehavior',
              valueComponent: dropdown
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText('Whether an attachment that survives a deletion, because another note still references it, is moved into that note\'s attachment folder.');
          f.createEl('br');
          f.appendText('When disabled, the attachment stays where the deleted note had put it.');
        }),
        name: 'Should rescue shared attachments',
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldRescueSharedAttachments',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText('Which note adopts an attachment several notes reference, highest priority first.');
          f.createEl('br');
          f.appendText('Insert each entry on a new line. An entry is an extension such as ');
          appendCodeBlock(f, '.md');
          f.appendText(', a ');
          appendCodeBlock(f, 'property:name=value');
          f.appendText(' match, or a ');
          appendCodeBlock(f, '/regular expression/');
          f.appendText('.');
          f.createEl('br');
          f.appendText('If the setting is empty, or two notes tie, the attachment is left where it is.');
        }),
        name: 'Note priorities',
        render: (setting) => {
          setting.addMultipleText((multipleText) => {
            this.bind({
              propertyName: 'notePriorities',
              valueComponent: multipleText
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText('Files with these extensions are attachments even though their extension says otherwise.');
          f.createEl('br');
          f.appendText('Insert each extension on a new line, e.g. ');
          appendCodeBlock(f, '.excalidraw.md');
          f.appendText(' for a drawing that is stored as markdown.');
        }),
        name: 'Treat as attachment extensions',
        render: (setting) => {
          setting.addMultipleText((multipleText) => {
            this.bind({
              propertyName: 'treatAsAttachmentExtensions',
              valueComponent: multipleText
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText('Handle only the following paths.');
          f.createEl('br');
          f.appendText('Insert each path on a new line');
          f.createEl('br');
          f.appendText('You can use path string or ');
          appendCodeBlock(f, '/regular expression/');
          f.createEl('br');
          f.appendText('If the setting is empty, the whole vault is handled.');
        }),
        name: 'Include paths',
        render: (setting) => {
          setting.addMultipleText((multipleText) => {
            this.bind({
              propertyName: 'includePaths',
              valueComponent: multipleText
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText('Leave the following paths alone.');
          f.createEl('br');
          f.appendText('Insert each path on a new line');
          f.createEl('br');
          f.appendText('You can use path string or ');
          appendCodeBlock(f, '/regular expression/');
          f.createEl('br');
          f.appendText('If the setting is empty, no paths are excluded.');
        }),
        name: 'Exclude paths',
        render: (setting) => {
          setting.addMultipleText((multipleText) => {
            this.bind({
              propertyName: 'excludePaths',
              valueComponent: multipleText
            });
          });
        }
      })
    ];
  }
}
