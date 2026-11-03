import type { App } from 'obsidian';

import {
  noop,
  noopAsync
} from '@mnaoumov/typescript-lib/function';
import { strictProxy } from '@mnaoumov/typescript-test-toolkit/strict-proxy';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { BulkOperationEvent } from '../../api.d.ts';
import type { PluginSettingsComponent } from '../settings/plugin-settings-component.ts';

import { PluginApiImpl } from './plugin-api-impl.ts';

describe('bulk operation lifecycle', () => {
  it.each(['moveMany', 'runInBatch'] as const)('brackets %s, including metadata settling and failures', async (operation) => {
    const events: BulkOperationEvent[] = [];
    const failure = new Error('failed move');
    let shouldFail = false;
    let shouldObserve = true;
    const work = vi.fn(async () => {
      if (shouldObserve) {
        expect(events.at(-1)).toEqual({ operation, phase: 'start' });
      }
      if (shouldFail) {
        throw failure;
      }
      await noopAsync();
    });
    const onCleanCache = vi.fn((callback: () => void) => {
      if (shouldObserve) {
        expect(events.at(-1)?.phase).toBe('start');
      }
      callback();
    });
    const api = new PluginApiImpl({
      app: strictProxy<App>({ metadataCache: strictProxy<App['metadataCache']>({ onCleanCache }) }),
      pluginSettingsComponent: strictProxy<PluginSettingsComponent>({}),
      renameDeleteHandlerComponent: { moveMany: work, runInBatch: work }
    });
    const unsubscribe = api.subscribeBulkOperations((notification) => {
      events.push(notification);
    });
    async function run(): Promise<void> {
      if (operation === 'moveMany') {
        await api.moveMany({ moves: [] });
      } else {
        await api.runInBatch(noopAsync);
      }
    }
    await run();
    shouldFail = true;
    await expect(run()).rejects.toBe(failure);
    expect(events).toEqual([
      { operation, phase: 'start' },
      { isSuccessful: true, operation, phase: 'end' },
      { operation, phase: 'start' },
      { isSuccessful: false, operation, phase: 'end' }
    ]);
    expect(onCleanCache).toHaveBeenCalledTimes(2);
    unsubscribe();
    unsubscribe();
    shouldObserve = false;
    shouldFail = false;
    await run();
    expect(events).toHaveLength(4);
  });

  it('replays an active start, isolates observer errors and supports independent teardown', async () => {
    const api = createApi();
    const events: BulkOperationEvent[] = [];
    function listener(notification: BulkOperationEvent): void {
      events.push(notification);
    }
    const error = new Error('observer failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const unsubscribeThrowing = api.subscribeBulkOperations(() => {
        throw error;
      });
      const unsubscribeAsync = api.subscribeBulkOperations(async () => {
        await Promise.reject(error);
      });
      const unsubscribeFirst = api.subscribeBulkOperations(listener);
      let unsubscribeSecond = noop;
      await api.runInBatch(async () => {
        unsubscribeSecond = api.subscribeBulkOperations(listener);
        expect(events).toEqual([{ operation: 'runInBatch', phase: 'start' }, { isReplay: true, operation: 'runInBatch', phase: 'start' }]);
        unsubscribeFirst();
        await expect(api.moveMany({ moves: [] })).rejects.toThrow('already running');
        await expect(api.runInBatch(noopAsync)).rejects.toThrow('already running');
      });
      expect(events.at(-1)).toEqual({ isSuccessful: true, operation: 'runInBatch', phase: 'end' });
      expect(events).toHaveLength(3);
      expect(consoleError).toHaveBeenCalledTimes(4);
      unsubscribeThrowing();
      unsubscribeAsync();
      unsubscribeSecond();
      api.subscribeBulkOperations(listener);
      api.dispose();
      await api.moveMany({ moves: [] });
      expect(events).toHaveLength(3);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('skips listeners removed during dispatch and freezes notifications', async () => {
    const api = createApi();
    const other = vi.fn();
    let unsubscribeOther = noop;
    const first = vi.fn((notification: BulkOperationEvent) => {
      expect(Object.isFrozen(notification)).toBe(true);
      unsubscribeOther();
    });
    api.subscribeBulkOperations(first);
    unsubscribeOther = api.subscribeBulkOperations(other);
    await api.moveMany({ moves: [] });
    expect(first).toHaveBeenCalledTimes(2);
    expect(other).not.toHaveBeenCalled();
  });

  it('holds end and the overlap guard until metadata parsing actually finishes', async () => {
    let finishParsing: (() => void) | undefined;
    const api = new PluginApiImpl({
      app: strictProxy<App>({
        metadataCache: strictProxy<App['metadataCache']>({
          onCleanCache(callback: () => void): void {
            finishParsing = callback;
          }
        })
      }),
      pluginSettingsComponent: strictProxy<PluginSettingsComponent>({}),
      renameDeleteHandlerComponent: { moveMany: noopAsync, runInBatch: noopAsync }
    });
    const listener = vi.fn();
    api.subscribeBulkOperations(listener);
    const running = api.moveMany({ moves: [] });
    await vi.waitFor(() => {
      expect(finishParsing).toBeTypeOf('function');
    });
    expect(listener.mock.calls).toEqual([[{ operation: 'moveMany', phase: 'start' }]]);
    await expect(api.moveMany({ moves: [] })).rejects.toThrow('already running');
    finishParsing?.();
    await running;
    expect(listener).toHaveBeenLastCalledWith({ isSuccessful: true, operation: 'moveMany', phase: 'end' });
  });
});

function createApi(): PluginApiImpl {
  return new PluginApiImpl({
    app: strictProxy<App>({
      metadataCache: strictProxy<App['metadataCache']>({
        onCleanCache: (callback: () => void) => {
          callback();
        }
      })
    }),
    pluginSettingsComponent: strictProxy<PluginSettingsComponent>({}),
    renameDeleteHandlerComponent: {
      moveMany: noopAsync,
      runInBatch: async (operation): Promise<void> => {
        await operation();
      }
    }
  });
}
