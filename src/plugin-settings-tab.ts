import type { SettingDefinitionItem } from 'obsidian';
import type { PluginGateComponent } from 'obsidian-dev-utils/obsidian/components/plugin-gate-component';
import type { PluginSettingsTabBaseConstructorParams } from 'obsidian-dev-utils/obsidian/plugin/plugin-settings-tab';

import { appendCodeBlock } from 'obsidian-dev-utils/obsidian/html-element';
import { PluginSettingsTabBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-settings-tab';

import type { PluginDependentsComponent } from './plugin-dependents-component.ts';
import type { PluginSettings } from './plugin-settings.ts';

import { RescueAttachmentUsedByMultipleNotesMode } from './plugin-settings.ts';
import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';

interface PluginSettingsTabConstructorParams extends PluginSettingsTabBaseConstructorParams<PluginSettings> {
  /**
   * Reaches the plugin's gate, LAZILY.
   *
   * A function rather than the component itself, because there is no component to hand over yet when this
   * tab is built: the base assigns `pluginGateComponent` only after the gate has loaded, and the gate loads
   * the feature surface — `onloadImpl`, where this tab is constructed — as it loads. Reading it eagerly
   * therefore throws. By the time a row renders, the assignment has long since happened.
   *
   * @returns The plugin gate component.
   */
  getPluginGateComponent(this: void): PluginGateComponent;

  /**
   * The plugins that declare this one as a dependency, listed at the top of the tab.
   */
  readonly pluginDependentsComponent: PluginDependentsComponent;
}

export class PluginSettingsTab extends PluginSettingsTabBase<PluginSettings> {
  private readonly getPluginGateComponent: (this: void) => PluginGateComponent;
  private readonly pluginDependentsComponent: PluginDependentsComponent;

  public constructor(params: PluginSettingsTabConstructorParams) {
    super(params);
    this.getPluginGateComponent = params.getPluginGateComponent;
    this.pluginDependentsComponent = params.pluginDependentsComponent;
  }

  /**
   * Groups the rows by the event they answer to, rather than listing twelve toggles flat.
   *
   * Each group leads with the switch that turns its behavior on, so the rows under it read as its details.
   * For deletions that is the whole story — everything below `Should handle deletions` is dead while it is
   * off. Renames are looser: `Should handle renames` governs the link update, while moving and renaming the
   * attachments are switches of their own, because moving a note's attachments with it is useful whoever
   * updates the links. `Scope` is last because it narrows both of the groups above it.
   *
   * The plugins depending on this one come first of all, when there are any: they are the answer to "why is
   * this plugin in my vault", which is the question a user has when they open this tab wondering whether to
   * remove it.
   *
   * The order within each group is unchanged from the flat tab, and matches the demo vault's own
   * progression: renaming, then deleting, then what counts as a note and how to limit the plugin.
   *
   * @returns The setting definitions.
   */
  protected override getSettingDefinitionItems(): SettingDefinitionItem[] {
    return [
      // The overlap banner has to travel as a ROW: Obsidian renders the declarative definitions and never
      // Calls `display()` once `getSettingDefinitions()` is non-empty, so there is no container to write
      // Into otherwise. The row body is emptied first, leaving the Setting element as a bare host for the
      // Banner. It cannot take a `visible` predicate yet: the library version this plugin compiles against
      // Renders the banner but does not expose whether there is one to render, so the row is hidden after
      // The fact when nothing was written into it. Swap this for a predicate once the floor moves.
      this.settingEx({
        name: '',
        render: (setting) => {
          setting.settingEl.empty();
          this.getPluginGateComponent().renderConflictWarningBanner(setting.settingEl);
          if (!setting.settingEl.hasChildNodes()) {
            setting.settingEl.hide();
          }
        },
        searchable: false
      }),
      this.settingGroupEx({
        heading: 'Plugins that depend on this one',
        items: [
          this.settingEx({
            desc: 'These enabled plugins declare this one as a dependency. Disabling or uninstalling it stops them until it is back. Select one to open its settings.',
            name: 'Required by',
            render: (setting) => {
              for (const dependent of this.pluginDependentsComponent.getDependents()) {
                setting.addButton((button) => {
                  button
                    .setButtonText(`${dependent.pluginName} ${dependent.pluginVersion}`)
                    .onClick(() => {
                      this.app.setting.openTabById(dependent.pluginId);
                    });
                });
              }
            }
          })
        ],
        // A predicate rather than a fixed value: this builder runs when the tab is registered, before any
        // Dependent has loaded, while the predicate is evaluated each time the tab is shown.
        visible: () => this.pluginDependentsComponent.getDependents().length > 0
      }),
      this.settingGroupEx({
        heading: 'Renames and moves',
        items: [
          this.settingEx({
            desc: createFragment((f) => {
              f.appendText('Whether to handle renames and moves at all.');
              f.createEl('br');
              f.appendText('When enabled, this plugin updates the links pointing at a renamed or moved file, replacing Obsidian\'s own link update.');
              f.createEl('br');
              f.appendText('When disabled, Obsidian updates the links on its own, and file name aliases are left as they are. Moving and renaming attachments are separate switches below, and work either way.');
              f.createEl('br');
              f.appendText('Off by default, like everything else here: installing this plugin changes nothing until you turn something on.');
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
          })
        ]
      }),
      this.settingGroupEx({
        heading: 'Deletions',
        items: [
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
              f.appendText('If the setting is empty, or two notes tie, the list settles nothing and the row below decides what happens.');
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
              f.appendText('What to do when the priority list above settles nothing — it is empty, nothing in it matches, or two notes tie.');
              f.createEl('br');
              f.appendText('Ask shows the notes keeping the attachment alive, says why the list did not decide, and moves the attachment into whichever one you pick.');
              f.createEl('br');
              f.appendText('Leave it in place keeps the attachment, and the folder holding it, exactly where they are.');
            }),
            name: 'When several notes could adopt the attachment',
            render: (setting) => {
              setting.addDropdown((dropdown) => {
                dropdown.addOptions({
                  [RescueAttachmentUsedByMultipleNotesMode.Prompt]: 'Ask which note adopts it',
                  [RescueAttachmentUsedByMultipleNotesMode.Skip]: 'Leave it in place'
                });
                this.bind({
                  propertyName: 'rescueAttachmentUsedByMultipleNotesMode',
                  valueComponent: dropdown
                });
              });
            }
          })
        ]
      }),
      this.settingGroupEx({
        heading: 'Scope',
        items: [
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
        ]
      })
    ];
  }
}
