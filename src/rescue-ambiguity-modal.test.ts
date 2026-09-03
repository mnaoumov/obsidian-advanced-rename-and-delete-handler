// @vitest-environment jsdom

import type { App as AppOriginal } from 'obsidian';

import {
  ButtonComponent,
  Modal,
  ToggleComponent
} from 'obsidian';
import { castTo } from 'obsidian-dev-utils/object-utils';
import { NoPriorityWinnerReason } from 'obsidian-dev-utils/obsidian/note-priority';
import { ensureNonNullable } from 'obsidian-dev-utils/type-guards';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  getNoPriorityWinnerReasonText,
  showRescueAmbiguityModal
} from './rescue-ambiguity-modal.ts';

/*
 * The links are Obsidian's to render and say nothing about the choice the dialog exists to collect, so
 * they stand in as bare spans. The buttons and the toggle keep their handlers on the component instance
 * rather than on the DOM node, so those are captured as they are registered — which is what lets a test
 * press a button exactly the way a user does.
 */
vi.mock('obsidian-dev-utils/obsidian/markdown', () => ({
  renderInternalLink: vi.fn((): Promise<HTMLElement> => Promise.resolve(createSpan()))
}));

const ATTACHMENT_PATH = 'Notes/Illustrated note/image.png';
const SURVIVING_NOTE_PATHS = ['Notes/a.md', 'Notes/b.md'];

const originalModalOpen = Modal.prototype.open;

let app: AppOriginal;
let buttonHandlers: Map<ButtonComponent, (mouseEvent: MouseEvent) => unknown>;
let openedModal: Modal | null;
let toggleHandlers: Map<ToggleComponent, (isEnabled: boolean) => void>;

beforeEach(() => {
  app = App.createConfigured__().asOriginalType__();
  buttonHandlers = new Map<ButtonComponent, (mouseEvent: MouseEvent) => unknown>();
  openedModal = null;
  toggleHandlers = new Map<ToggleComponent, (isEnabled: boolean) => void>();

  // Dismissing the dialog is a real answer, and the only way to reach it is to hold on to the instance.
  vi.spyOn(Modal.prototype, 'open').mockImplementation(function openMock(this: Modal): void {
    captureOpenedModal(this);
    originalModalOpen.call(this);
  });

  vi.spyOn(ButtonComponent.prototype, 'onClick').mockImplementation(
    function onClickMock(this: ButtonComponent, callback: (mouseEvent: MouseEvent) => unknown): ButtonComponent {
      buttonHandlers.set(this, callback);
      return this;
    }
  );

  vi.spyOn(ToggleComponent.prototype, 'onChange').mockImplementation(
    function onChangeMock(this: ToggleComponent, callback: (isEnabled: boolean) => void): ToggleComponent {
      toggleHandlers.set(this, callback);
      return this;
    }
  );
});

function buttonTexts(): string[] {
  return [...buttonHandlers.keys()].map((button) => button.buttonEl.textContent);
}

function captureOpenedModal(modal: Modal): void {
  openedModal = modal;
}

function pressButton(buttonText: string): void {
  for (const [buttonComponent, handler] of buttonHandlers) {
    if (buttonComponent.buttonEl.textContent === buttonText) {
      handler(castTo<MouseEvent>({}));
      return;
    }
  }

  throw new Error(`The dialog has no "${buttonText}" button`);
}

function show(survivingNotePaths: readonly string[] = SURVIVING_NOTE_PATHS): ReturnType<typeof showRescueAmbiguityModal> {
  return showRescueAmbiguityModal({
    app,
    attachmentPath: ATTACHMENT_PATH,
    noPriorityWinnerReason: NoPriorityWinnerReason.Tie,
    survivingNotePaths
  });
}

describe('showRescueAmbiguityModal', () => {
  it('should offer one button per surviving note, plus the way out', async () => {
    const decisionPromise = show();

    expect(buttonTexts()).toEqual(['Move to a.md', 'Move to b.md', 'Leave it here']);

    pressButton('Leave it here');
    await decisionPromise;
  });

  it('should resolve to the note the user picks', async () => {
    const decisionPromise = show();

    pressButton('Move to b.md');

    expect(await decisionPromise).toEqual({ adoptingNotePath: 'Notes/b.md', shouldUseSameActionForRest: false });
  });

  it('should resolve to leaving the attachment alone', async () => {
    const decisionPromise = show();

    pressButton('Leave it here');

    expect(await decisionPromise).toEqual({ adoptingNotePath: null, shouldUseSameActionForRest: false });
  });

  it('should carry the answer onto the rest when the user asks it to', async () => {
    const decisionPromise = show();

    for (const handler of toggleHandlers.values()) {
      handler(true);
    }
    pressButton('Move to a.md');

    expect(await decisionPromise).toEqual({ adoptingNotePath: 'Notes/a.md', shouldUseSameActionForRest: true });
  });

  it('should leave the attachment alone when the dialog is dismissed without an answer', async () => {
    const decisionPromise = show();

    ensureNonNullable(openedModal).close();

    expect(await decisionPromise).toEqual({ adoptingNotePath: null, shouldUseSameActionForRest: false });
  });

  it('should still resolve the right path when two surviving notes share a name', async () => {
    const decisionPromise = show(['Archive/note.md', 'Notes/note.md']);

    // Both buttons read the same, so what a press means cannot be read off the label alone.
    expect(buttonTexts()).toEqual(['Move to note.md', 'Move to note.md', 'Leave it here']);

    pressButton('Move to note.md');

    expect(await decisionPromise).toEqual({ adoptingNotePath: 'Archive/note.md', shouldUseSameActionForRest: false });
  });
});

describe('getNoPriorityWinnerReasonText', () => {
  it.each([
    [NoPriorityWinnerReason.EmptyList, 'empty'],
    [NoPriorityWinnerReason.NoMatch, 'matches'],
    [NoPriorityWinnerReason.Tie, 'tie']
  ])('should explain %s in the user\'s terms', (reason, expectedFragment) => {
    const text = getNoPriorityWinnerReasonText(reason);

    expect(text).toContain(expectedFragment);
    // Every reason points at the setting the user has to go and change.
    expect(text).toContain('Note priorities');
  });

  it('should refuse a reason it has no sentence for, rather than showing an empty explanation', () => {
    expect(() => getNoPriorityWinnerReasonText(castTo<NoPriorityWinnerReason>('not-a-reason'))).toThrow();
  });
});
