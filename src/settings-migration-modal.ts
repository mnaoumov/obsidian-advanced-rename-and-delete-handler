/**
 * @file
 *
 * The comparison dialog a settings migration goes through.
 *
 * A consumer plugin proposes the values it used to hold; this dialog puts them next to what this plugin
 * holds now and lets the user approve, edit or decline them. Nothing is written until the user presses OK,
 * and a single row is declined by resetting it to the current value rather than by cancelling everything.
 */

import type { App } from 'obsidian';
import type { PromiseResolve } from 'obsidian-dev-utils/async';

import {
  ButtonComponent,
  DropdownComponent,
  ExtraButtonComponent,
  Setting,
  TextAreaComponent,
  ToggleComponent
} from 'obsidian';
import {
  ModalBase,
  showModal
} from 'obsidian-dev-utils/obsidian/modals/modal';
import { assertNever } from 'obsidian-dev-utils/type-guards';

import type {
  MigratableSettingValue,
  SettingsMigrationRow
} from './settings-migration.ts';

import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';
import {
  formatMigratableSettingValue,
  formatStringListForEditing,
  getEmptyFolderBehaviorLabel,
  MigratableSettingKind,
  parseStringList,
  toEmptyFolderBehaviorOrNull
} from './settings-migration.ts';

/**
 * Parameters for {@link showSettingsMigrationModal}.
 */
export interface ShowSettingsMigrationModalParams {
  /**
   * An Obsidian app instance.
   */
  readonly app: App;

  /**
   * The rows to review — one per setting the proposal would actually change.
   */
  readonly rows: readonly SettingsMigrationRow[];

  /**
   * The display name of the plugin making the proposal.
   */
  readonly sourcePluginName: string;
}

interface SettingsMigrationModalConstructorParams extends ShowSettingsMigrationModalParams {
  readonly promiseResolve: PromiseResolve<null | SettingsMigrationRow[]>;
}

class SettingsMigrationModal extends ModalBase<null | SettingsMigrationRow[]> {
  private approvedRows: null | SettingsMigrationRow[] = null;
  private readonly editedValues = new Map<string, MigratableSettingValue>();
  private readonly rows: readonly SettingsMigrationRow[];
  private readonly sourcePluginName: string;

  public constructor(params: SettingsMigrationModalConstructorParams) {
    super(params);
    this.rows = params.rows;
    this.sourcePluginName = params.sourcePluginName;
  }

  public override onClose(): void {
    this.promiseResolve(this.approvedRows);
  }

  public override onOpen(): void {
    this.titleEl.setText(`Settings proposed by ${this.sourcePluginName}`);

    this.contentEl.createEl('p', {
      text: `${this.sourcePluginName} used to handle renames and deletions itself and no longer does. It proposes the settings it held, so this vault keeps behaving the way it did.`
    });
    this.contentEl.createEl('p', {
      text: 'Each row shows what this plugin holds now and what is proposed. Edit a suggested value, or reset a row to keep the current one. Nothing is written until you press OK.'
    });

    for (const row of this.rows) {
      this.renderRow(row);
    }

    const buttonsEl = this.contentEl.createDiv();

    const okButton = new ButtonComponent(buttonsEl);
    okButton.setButtonText('OK');
    okButton.setCta();
    okButton.onClick(() => {
      this.approvedRows = this.rows.map((row) => ({
        ...row,
        proposedValue: this.editedValues.get(row.descriptor.propertyName) ?? row.proposedValue
      }));
      this.close();
    });

    const cancelButton = new ButtonComponent(buttonsEl);
    cancelButton.setButtonText('Cancel');
    cancelButton.onClick(this.close.bind(this));
  }

  private renderRow(row: SettingsMigrationRow): void {
    const setting = new Setting(this.contentEl);
    setting.setName(row.descriptor.name);
    setting.setDesc(`Currently: ${formatMigratableSettingValue(row.currentValue)}`);

    const resetToCurrentValue = this.renderValueControl(setting, row);

    const resetButton = new ExtraButtonComponent(setting.controlEl);
    resetButton.setIcon('rotate-ccw');
    resetButton.setTooltip('Reset to the current value, leaving this setting as it is');
    resetButton.onClick(() => {
      this.editedValues.set(row.descriptor.propertyName, row.currentValue);
      resetToCurrentValue();
    });
  }

  private renderValueControl(setting: Setting, row: SettingsMigrationRow): () => void {
    const propertyName = row.descriptor.propertyName;

    switch (row.descriptor.kind) {
      case MigratableSettingKind.Boolean: {
        const toggleComponent = new ToggleComponent(setting.controlEl);
        toggleComponent.setValue(row.proposedValue === true);
        toggleComponent.onChange((value) => {
          this.editedValues.set(propertyName, value);
        });
        return () => {
          toggleComponent.setValue(row.currentValue === true);
        };
      }

      case MigratableSettingKind.EmptyFolder: {
        const dropdownComponent = new DropdownComponent(setting.controlEl);
        /* eslint-disable perfectionist/sort-objects -- Need to keep enum order. */
        dropdownComponent.addOptions({
          [EmptyFolderBehavior.Keep]: getEmptyFolderBehaviorLabel(EmptyFolderBehavior.Keep),
          [EmptyFolderBehavior.Delete]: getEmptyFolderBehaviorLabel(EmptyFolderBehavior.Delete),
          [EmptyFolderBehavior.DeleteWithEmptyParents]: getEmptyFolderBehaviorLabel(EmptyFolderBehavior.DeleteWithEmptyParents)
        });
        /* eslint-enable perfectionist/sort-objects -- Need to keep enum order. */
        dropdownComponent.setValue(formatStringListForEditing(row.proposedValue));
        dropdownComponent.onChange((value) => {
          const emptyFolderBehavior = toEmptyFolderBehaviorOrNull(value);
          if (emptyFolderBehavior !== null) {
            this.editedValues.set(propertyName, emptyFolderBehavior);
          }
        });
        return () => {
          dropdownComponent.setValue(formatStringListForEditing(row.currentValue));
        };
      }

      case MigratableSettingKind.StringList: {
        const textAreaComponent = new TextAreaComponent(setting.controlEl);
        textAreaComponent.setValue(formatStringListForEditing(row.proposedValue));
        textAreaComponent.onChange((value) => {
          this.editedValues.set(propertyName, parseStringList(value));
        });
        return () => {
          textAreaComponent.setValue(formatStringListForEditing(row.currentValue));
        };
      }

      default: {
        return assertNever(row.descriptor.kind);
      }
    }
  }
}

/**
 * Shows the comparison dialog and waits for the user to settle it.
 *
 * @param params - The proposal to review.
 * @returns The rows to write, carrying whatever the user edited them to, or `null` when the user cancelled.
 */
export async function showSettingsMigrationModal(params: ShowSettingsMigrationModalParams): Promise<null | SettingsMigrationRow[]> {
  return await showModal<null | SettingsMigrationRow[]>((promiseResolve) =>
    new SettingsMigrationModal({
      ...params,
      promiseResolve
    })
  );
}
