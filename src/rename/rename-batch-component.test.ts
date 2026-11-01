import type {
  App,
  EventRef,
  TAbstractFile
} from 'obsidian';

import { noopAsync } from '@mnaoumov/typescript-lib/function';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { RenameBatchHandler } from './rename-batch-component.ts';

import {
  RENAME_BATCH_DELAY_IN_MILLISECONDS,
  RenameBatchComponent
} from './rename-batch-component.ts';

type RenameListener = (file: TAbstractFile, oldPath: string) => void;

let listeners: RenameListener[];

function createComponent(handlers: readonly RenameBatchHandler[]): RenameBatchComponent {
  const app = castTo<App>({
    vault: {
      offref: vi.fn(),
      on: (_name: string, listener: RenameListener): EventRef => {
        listeners.push(listener);
        return castTo<EventRef>({});
      }
    }
  });
  const component = new RenameBatchComponent({ app, handlers });
  component.load();
  return component;
}

function fireRename(oldPath: string, newPath: string): void {
  for (const listener of listeners) {
    listener(castTo<TAbstractFile>({ path: newPath }), oldPath);
  }
}

beforeEach(() => {
  listeners = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RenameBatchComponent', () => {
  it('should hand on one batch once the renames have stopped for the delay', async () => {
    const batches: Map<string, string>[] = [];
    createComponent([
      async (renames): Promise<void> => {
        batches.push(new Map(renames));
        await noopAsync();
      }
    ]);

    fireRename('a', 'b');
    await vi.advanceTimersByTimeAsync(RENAME_BATCH_DELAY_IN_MILLISECONDS - 1);
    fireRename('c', 'd');
    await vi.advanceTimersByTimeAsync(RENAME_BATCH_DELAY_IN_MILLISECONDS - 1);

    expect(batches).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(batches).toEqual([new Map([['a', 'b'], ['c', 'd']])]);

    fireRename('e', 'f');
    await vi.advanceTimersByTimeAsync(RENAME_BATCH_DELAY_IN_MILLISECONDS);

    expect(batches).toEqual([new Map([['a', 'b'], ['c', 'd']]), new Map([['e', 'f']])]);
  });

  it('should fold a path renamed twice into one entry from its first path to its last', async () => {
    const handler = vi.fn(async (): Promise<void> => {
      await noopAsync();
    });
    createComponent([handler]);

    fireRename('a', 'b');
    fireRename('b', 'c');
    await vi.advanceTimersByTimeAsync(RENAME_BATCH_DELAY_IN_MILLISECONDS);

    expect(handler).toHaveBeenCalledWith(new Map([['a', 'c']]));
  });

  it('should run every handler in order, past one that fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const calls: string[] = [];
    createComponent([
      async (): Promise<void> => {
        calls.push('first');
        await Promise.reject(new Error('boom'));
      },
      async (): Promise<void> => {
        calls.push('second');
        await noopAsync();
      }
    ]);

    fireRename('a', 'b');
    await vi.advanceTimersByTimeAsync(RENAME_BATCH_DELAY_IN_MILLISECONDS);

    expect(calls).toEqual(['first', 'second']);
    expect(consoleError).toHaveBeenCalledWith('A rename follow-up failed', expect.any(Error));
    consoleError.mockRestore();
  });

  it('should drop a pending batch on unload', async () => {
    const handler = vi.fn(async (): Promise<void> => {
      await noopAsync();
    });
    const component = createComponent([handler]);

    fireRename('a', 'b');
    component.unload();
    await vi.advanceTimersByTimeAsync(RENAME_BATCH_DELAY_IN_MILLISECONDS);

    expect(handler).not.toHaveBeenCalled();
  });

  it('should unload cleanly with nothing pending', () => {
    const component = createComponent([]);

    expect(() => {
      component.unload();
    }).not.toThrow();
  });
});
