// @vitest-environment jsdom

import type { App as AppOriginal } from 'obsidian';

import {
  ButtonComponent,
  DropdownComponent,
  ExtraButtonComponent,
  TextAreaComponent,
  ToggleComponent
} from 'obsidian';
import { castTo } from 'obsidian-dev-utils/object-utils';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { SettingsMigrationRow } from './settings-migration.ts';

import { EmptyFolderBehavior } from './rename-delete-handler-component.ts';
import { showSettingsMigrationModal } from './settings-migration-modal.ts';
import { MigratableSettingKind } from './settings-migration.ts';

/*
 * The modal's components keep their handlers on the component instance rather than on the DOM node, so a
 * `click()` on the rendered element would do nothing. The handlers are captured as they are registered,
 * which is what lets a test press OK, edit a value, or reset a row exactly the way a user does.
 */

const BOOLEAN_ROW: SettingsMigrationRow = {
  currentValue: false,
  descriptor: {
    kind: MigratableSettingKind.Boolean,
    name: 'Should handle deletions',
    propertyName: 'shouldHandleDeletions'
  },
  proposedValue: true
};

const EMPTY_FOLDER_BEHAVIOR_ROW: SettingsMigrationRow = {
  currentValue: EmptyFolderBehavior.Keep,
  descriptor: {
    kind: MigratableSettingKind.EmptyFolder,
    name: 'Empty folder behavior',
    propertyName: 'emptyFolderBehavior'
  },
  proposedValue: EmptyFolderBehavior.Delete
};

const STRING_LIST_ROW: SettingsMigrationRow = {
  currentValue: ['.excalidraw.md'],
  descriptor: {
    kind: MigratableSettingKind.StringList,
    name: 'Treat as attachment extensions',
    propertyName: 'treatAsAttachmentExtensions'
  },
  proposedValue: ['.excalidraw.md', '.canvas']
};

let app: AppOriginal;
let buttonHandlers: Map<ButtonComponent, (mouseEvent: MouseEvent) => unknown>;
let extraButtonHandlers: Map<ExtraButtonComponent, () => unknown>;
let dropdownHandlers: Map<DropdownComponent, (value: string) => void>;
let textAreaHandlers: Map<TextAreaComponent, (value: string) => void>;
let toggleHandlers: Map<ToggleComponent, (isEnabled: boolean) => void>;

beforeEach(() => {
  app = App.createConfigured__().asOriginalType__();
  buttonHandlers = new Map<ButtonComponent, (mouseEvent: MouseEvent) => unknown>();
  extraButtonHandlers = new Map<ExtraButtonComponent, () => unknown>();
  dropdownHandlers = new Map<DropdownComponent, (value: string) => void>();
  textAreaHandlers = new Map<TextAreaComponent, (value: string) => void>();
  toggleHandlers = new Map<ToggleComponent, (isEnabled: boolean) => void>();

  vi.spyOn(ButtonComponent.prototype, 'onClick').mockImplementation(function onClickMock(this: ButtonComponent, callback: (mouseEvent: MouseEvent) => unknown): ButtonComponent {
    buttonHandlers.set(this, callback);
    return this;
  });

  vi.spyOn(ExtraButtonComponent.prototype, 'onClick').mockImplementation(
    function onClickMock(this: ExtraButtonComponent, callback: () => unknown): ExtraButtonComponent {
      extraButtonHandlers.set(this, callback);
      return this;
    }
  );

  vi.spyOn(ToggleComponent.prototype, 'onChange').mockImplementation(
    function onChangeMock(this: ToggleComponent, callback: (isEnabled: boolean) => void): ToggleComponent {
      toggleHandlers.set(this, callback);
      return this;
    }
  );

  vi.spyOn(DropdownComponent.prototype, 'onChange').mockImplementation(
    function onChangeMock(this: DropdownComponent, callback: (value: string) => void): DropdownComponent {
      dropdownHandlers.set(this, callback);
      return this;
    }
  );

  vi.spyOn(TextAreaComponent.prototype, 'onChange').mockImplementation(
    function onChangeMock(this: TextAreaComponent, callback: (value: string) => void): TextAreaComponent {
      textAreaHandlers.set(this, callback);
      return this;
    }
  );
});

function pressButton(buttonText: string): void {
  for (const [buttonComponent, handler] of buttonHandlers) {
    if (buttonComponent.buttonEl.textContent === buttonText) {
      handler(castTo<MouseEvent>({}));
      return;
    }
  }

  throw new Error(`The dialog has no "${buttonText}" button`);
}

describe('showSettingsMigrationModal', () => {
  it('applies the proposal as it stands when the user presses OK', async () => {
    const rowsPromise = showSettingsMigrationModal({
      app,
      rows: [BOOLEAN_ROW],
      sourcePluginName: 'Custom Attachment Location'
    });

    pressButton('OK');

    const rows = await rowsPromise;
    expect(rows).toEqual([BOOLEAN_ROW]);
  });

  it('writes nothing when the user cancels', async () => {
    const rowsPromise = showSettingsMigrationModal({
      app,
      rows: [BOOLEAN_ROW],
      sourcePluginName: 'Custom Attachment Location'
    });

    pressButton('Cancel');

    expect(await rowsPromise).toBeNull();
  });

  it('carries an edited toggle into the approved row', async () => {
    const rowsPromise = showSettingsMigrationModal({
      app,
      rows: [BOOLEAN_ROW],
      sourcePluginName: 'Custom Attachment Location'
    });

    for (const handler of toggleHandlers.values()) {
      handler(false);
    }

    pressButton('OK');

    const rows = await rowsPromise;
    expect(rows?.[0]?.proposedValue).toBe(false);
  });

  it('carries an edited dropdown and an edited list into the approved rows', async () => {
    const rowsPromise = showSettingsMigrationModal({
      app,
      rows: [EMPTY_FOLDER_BEHAVIOR_ROW, STRING_LIST_ROW],
      sourcePluginName: 'Custom Attachment Location'
    });

    for (const handler of dropdownHandlers.values()) {
      handler(EmptyFolderBehavior.DeleteWithEmptyParents);
      // A value the dropdown could not have produced is ignored rather than stored.
      handler('not-a-behavior');
    }

    for (const handler of textAreaHandlers.values()) {
      handler('.canvas\n\n  .excalidraw.md  \n');
    }

    pressButton('OK');

    const rows = await rowsPromise;
    expect(rows?.[0]?.proposedValue).toBe(EmptyFolderBehavior.DeleteWithEmptyParents);
    expect(rows?.[1]?.proposedValue).toEqual(['.canvas', '.excalidraw.md']);
  });

  it('refuses a row whose kind it cannot render', async () => {
    await expect(async () => {
      await showSettingsMigrationModal({
        app,
        rows: [{
          currentValue: false,
          descriptor: {
            kind: castTo<MigratableSettingKind>('Unknown'),
            name: 'Something new',
            propertyName: 'shouldHandleDeletions'
          },
          proposedValue: true
        }],
        sourcePluginName: 'Custom Attachment Location'
      });
    }).rejects.toThrow();
  });

  it('resets a row to the current value, which is how one setting is declined', async () => {
    const rowsPromise = showSettingsMigrationModal({
      app,
      rows: [
        BOOLEAN_ROW,
        EMPTY_FOLDER_BEHAVIOR_ROW,
        STRING_LIST_ROW
      ],
      sourcePluginName: 'Custom Attachment Location'
    });

    for (const handler of extraButtonHandlers.values()) {
      handler();
    }

    pressButton('OK');

    const rows = await rowsPromise;
    expect(rows?.map((row) => row.proposedValue)).toEqual([
      BOOLEAN_ROW.currentValue,
      EMPTY_FOLDER_BEHAVIOR_ROW.currentValue,
      STRING_LIST_ROW.currentValue
    ]);
  });
});
