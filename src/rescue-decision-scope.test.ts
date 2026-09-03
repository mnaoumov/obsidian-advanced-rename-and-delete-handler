import type { PromiseResolve } from 'obsidian-dev-utils/async';

import { noop } from 'obsidian-dev-utils/function';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type {
  RescueAnswer,
  RescueDecision
} from './rescue-decision-scope.ts';

import { RescueDecisionScope } from './rescue-decision-scope.ts';

const ATTACHMENT_PATH = 'attachments/image.png';
const OTHER_ATTACHMENT_PATH = 'attachments/chart.png';
const SURVIVORS = ['Notes/a.md', 'Notes/b.md'];

function answering(adoptingNotePath: null | string, shouldUseSameActionForRest = false): () => Promise<RescueAnswer> {
  return () =>
    Promise.resolve({
      decision: { adoptingNotePath },
      shouldUseSameActionForRest
    });
}

function resolve(
  scope: RescueDecisionScope,
  attachmentPath: string,
  ask: () => Promise<RescueAnswer>,
  survivingNotePaths: readonly string[] = SURVIVORS
): Promise<RescueDecision> {
  return scope.resolveDecision({
    ask,
    attachmentPath,
    survivingNotePaths
  });
}

describe('RescueDecisionScope', () => {
  it('should put the question when nothing covers the attachment yet', async () => {
    const scope = new RescueDecisionScope();
    scope.enter();
    const ask = vi.fn(answering('Notes/b.md'));

    expect(await resolve(scope, ATTACHMENT_PATH, ask)).toEqual({ adoptingNotePath: 'Notes/b.md' });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('should not put the same question twice in one deletion', async () => {
    const scope = new RescueDecisionScope();
    scope.enter();
    const ask = vi.fn(answering('Notes/b.md'));

    await resolve(scope, ATTACHMENT_PATH, ask);
    const secondDecision = await resolve(scope, ATTACHMENT_PATH, ask);

    expect(secondDecision).toEqual({ adoptingNotePath: 'Notes/b.md' });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('should remember a decline, which is an answer like any other', async () => {
    const scope = new RescueDecisionScope();
    scope.enter();
    const ask = vi.fn(answering(null));

    await resolve(scope, ATTACHMENT_PATH, ask);
    expect(await resolve(scope, ATTACHMENT_PATH, ask)).toEqual({ adoptingNotePath: null });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('should make a second, OVERLAPPING ask join the first rather than opening its own', async () => {
    const scope = new RescueDecisionScope();
    scope.enter();
    let promiseResolve: PromiseResolve<RescueAnswer> = noop;
    const ask = vi.fn(() =>
      new Promise<RescueAnswer>((innerResolve) => {
        promiseResolve = innerResolve;
      })
    );

    // The folder replay asks, and — before the user has answered — the owning note's own handler asks too.
    const firstPromise = resolve(scope, ATTACHMENT_PATH, ask);
    const secondPromise = resolve(scope, ATTACHMENT_PATH, ask);

    promiseResolve({ decision: { adoptingNotePath: 'Notes/a.md' }, shouldUseSameActionForRest: false });

    expect(await firstPromise).toEqual({ adoptingNotePath: 'Notes/a.md' });
    expect(await secondPromise).toEqual({ adoptingNotePath: 'Notes/a.md' });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('should put the question again after a failed one, rather than handing on the failure', async () => {
    const scope = new RescueDecisionScope();
    scope.enter();
    const failingAsk = vi.fn(() => Promise.reject(new Error('the dialog blew up')));

    await expect(resolve(scope, ATTACHMENT_PATH, failingAsk)).rejects.toThrow('the dialog blew up');

    const ask = vi.fn(answering('Notes/b.md'));
    expect(await resolve(scope, ATTACHMENT_PATH, ask)).toEqual({ adoptingNotePath: 'Notes/b.md' });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('should ask separately about a different attachment unless the answer was made to stand', async () => {
    const scope = new RescueDecisionScope();
    scope.enter();
    await resolve(scope, ATTACHMENT_PATH, answering('Notes/b.md'));

    const ask = vi.fn(answering('Notes/a.md'));
    expect(await resolve(scope, OTHER_ATTACHMENT_PATH, ask)).toEqual({ adoptingNotePath: 'Notes/a.md' });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('should carry an answer made to stand onto the attachments still to come', async () => {
    const scope = new RescueDecisionScope();
    scope.enter();
    await resolve(scope, ATTACHMENT_PATH, answering('Notes/b.md', true));

    const ask = vi.fn(answering('Notes/a.md'));
    expect(await resolve(scope, OTHER_ATTACHMENT_PATH, ask)).toEqual({ adoptingNotePath: 'Notes/b.md' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('should ask again when the note the standing answer names does not reference this attachment', async () => {
    const scope = new RescueDecisionScope();
    scope.enter();
    await resolve(scope, ATTACHMENT_PATH, answering('Notes/b.md', true));

    const ask = vi.fn(answering(null));
    expect(await resolve(scope, OTHER_ATTACHMENT_PATH, ask, ['Notes/x.md', 'Notes/y.md'])).toEqual({ adoptingNotePath: null });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('should carry a standing decline onto every attachment, whichever notes hold it', async () => {
    const scope = new RescueDecisionScope();
    scope.enter();
    await resolve(scope, ATTACHMENT_PATH, answering(null, true));

    const ask = vi.fn(answering('Notes/x.md'));
    expect(await resolve(scope, OTHER_ATTACHMENT_PATH, ask, ['Notes/x.md', 'Notes/y.md'])).toEqual({ adoptingNotePath: null });
    expect(ask).not.toHaveBeenCalled();
  });

  it('should forget everything once the last deletion in flight has finished', async () => {
    const scope = new RescueDecisionScope();
    scope.enter();
    await resolve(scope, ATTACHMENT_PATH, answering('Notes/b.md', true));

    scope.exit();

    const ask = vi.fn(answering(null));
    expect(await resolve(scope, ATTACHMENT_PATH, ask)).toEqual({ adoptingNotePath: null });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('should hold the answers while another deletion of the same cascade is still in flight', async () => {
    const scope = new RescueDecisionScope();
    // The folder replay, and one of the per-file handlers its deletions enqueued.
    scope.enter();
    scope.enter();
    await resolve(scope, ATTACHMENT_PATH, answering('Notes/b.md'));

    scope.exit();

    const heldAsk = vi.fn(answering(null));
    expect(await resolve(scope, ATTACHMENT_PATH, heldAsk)).toEqual({ adoptingNotePath: 'Notes/b.md' });
    expect(heldAsk).not.toHaveBeenCalled();

    scope.exit();

    const freshAsk = vi.fn(answering(null));
    expect(await resolve(scope, ATTACHMENT_PATH, freshAsk)).toEqual({ adoptingNotePath: null });
    expect(freshAsk).toHaveBeenCalledOnce();
  });

  it('should keep working after an unbalanced exit rather than latching below zero', async () => {
    const scope = new RescueDecisionScope();

    scope.exit();

    scope.enter();
    await resolve(scope, ATTACHMENT_PATH, answering('Notes/b.md'));

    const heldAsk = vi.fn(answering(null));
    expect(await resolve(scope, ATTACHMENT_PATH, heldAsk)).toEqual({ adoptingNotePath: 'Notes/b.md' });

    scope.exit();

    const freshAsk = vi.fn(answering(null));
    expect(await resolve(scope, ATTACHMENT_PATH, freshAsk)).toEqual({ adoptingNotePath: null });
    expect(freshAsk).toHaveBeenCalledOnce();
  });
});
