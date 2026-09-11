import type { App as AppOriginal } from 'obsidian';
import type { PluginLifecycleEventPayload } from 'obsidian-dev-utils/obsidian/plugin/plugin-lifecycle-events';

import {
  PLUGIN_LOADED_EVENT_NAME,
  PLUGIN_UNLOADED_EVENT_NAME
} from 'obsidian-dev-utils/obsidian/plugin/plugin-lifecycle-events';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it
} from 'vitest';

import { PluginDependentsComponent } from './plugin-dependents-component.ts';

const PLUGIN_ID = 'advanced-rename-and-delete-handler';

let app: AppOriginal;
let component: PluginDependentsComponent;

beforeEach(() => {
  app = App.createConfigured__().asOriginalType__();
  component = new PluginDependentsComponent({ app, pluginId: PLUGIN_ID });
  component.load();
});

describe('PluginDependentsComponent', () => {
  it('should know of no dependent before any plugin has announced itself', () => {
    expect(component.getDependents()).toEqual([]);
  });

  it('should record a plugin whose broadcast names this one as a dependency', () => {
    app.workspace.trigger(PLUGIN_LOADED_EVENT_NAME, createPayload('obsidian-custom-attachment-location', [PLUGIN_ID]));

    expect(component.getDependents()).toEqual([
      {
        pluginId: 'obsidian-custom-attachment-location',
        pluginName: 'Name of obsidian-custom-attachment-location',
        pluginVersion: '12.1.0'
      }
    ]);
  });

  it('should ignore a plugin that depends on something else, or on nothing', () => {
    app.workspace.trigger(PLUGIN_LOADED_EVENT_NAME, createPayload('other', ['some-other-plugin']));
    app.workspace.trigger(PLUGIN_LOADED_EVENT_NAME, createPayload('independent', []));

    expect(component.getDependents()).toEqual([]);
  });

  it('should forget a dependent once it unloads', () => {
    app.workspace.trigger(PLUGIN_LOADED_EVENT_NAME, createPayload('dependent', [PLUGIN_ID]));
    app.workspace.trigger(PLUGIN_UNLOADED_EVENT_NAME, createPayload('dependent', [PLUGIN_ID]));

    expect(component.getDependents()).toEqual([]);
  });

  // A dependent whose gate closed because this plugin went away announces itself again once it is back, and
  // Must be listed once, not twice.
  it('should list a dependent that announces itself twice only once', () => {
    app.workspace.trigger(PLUGIN_LOADED_EVENT_NAME, createPayload('dependent', [PLUGIN_ID]));
    app.workspace.trigger(PLUGIN_LOADED_EVENT_NAME, createPayload('dependent', [PLUGIN_ID]));

    expect(component.getDependents()).toHaveLength(1);
  });

  it('should stop listening once unloaded', () => {
    component.unload();
    app.workspace.trigger(PLUGIN_LOADED_EVENT_NAME, createPayload('dependent', [PLUGIN_ID]));

    expect(component.getDependents()).toEqual([]);
  });
});

function createPayload(pluginId: string, dependencyPluginIds: readonly string[]): PluginLifecycleEventPayload {
  return {
    apiVersions: [],
    dependencyPluginIds,
    pluginId,
    pluginName: `Name of ${pluginId}`,
    pluginVersion: '12.1.0'
  };
}
