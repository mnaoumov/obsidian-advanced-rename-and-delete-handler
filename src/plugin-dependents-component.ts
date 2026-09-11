/**
 * @file
 *
 * Keeps track of which plugins depend on this one, so the settings tab can say why it is in the vault.
 *
 * Obsidian's manifest has no dependency field, so nothing in the plugin list tells a user that this plugin is
 * load-bearing. A dependent declares the relationship through `obsidian-dev-utils`, and announces it on
 * `app.workspace` as the `dependencyPluginIds` of its `plugin-loaded` broadcast — the only place the
 * relationship can be read from this end, since the plugin-API registry only answers from the consumer's side.
 *
 * Listening is enough to be complete. A dependent cannot finish loading before this plugin has published its
 * API, because that is exactly what its dependency gate waits for, and this component subscribes before the
 * API is published. So every dependent's `plugin-loaded` arrives after the subscription. A dependent that goes
 * away announces `plugin-unloaded`, and one whose gate closes because this plugin went away announces it too
 * and announces `plugin-loaded` again once this plugin is back.
 *
 * What it cannot see is a dependent that is installed but disabled: that plugin broadcasts nothing. The list is
 * the enabled dependents, and the settings tab says so.
 */

import type { App } from 'obsidian';
import type { PluginLifecycleEventPayload } from 'obsidian-dev-utils/obsidian/plugin/plugin-lifecycle-events';

import { ComponentEx } from 'obsidian-dev-utils/obsidian/components/component-ex';
import {
  PLUGIN_LOADED_EVENT_NAME,
  PLUGIN_UNLOADED_EVENT_NAME
} from 'obsidian-dev-utils/obsidian/plugin/plugin-lifecycle-events';

/**
 * An enabled plugin that declares this one as a dependency.
 */
export interface PluginDependent {
  /**
   * The dependent's `manifest.id`, which is also the id its settings tab opens by.
   */
  readonly pluginId: string;

  /**
   * The dependent's `manifest.name`, for display.
   */
  readonly pluginName: string;

  /**
   * The dependent's `manifest.version`, for display.
   */
  readonly pluginVersion: string;
}

interface PluginDependentsComponentConstructorParams {
  readonly app: App;

  /**
   * This plugin's own `manifest.id` — what a dependent names in its `dependencyPluginIds`.
   */
  readonly pluginId: string;
}

export class PluginDependentsComponent extends ComponentEx {
  private readonly app: App;
  private readonly dependents = new Map<string, PluginDependent>();
  private readonly pluginId: string;

  public constructor(params: PluginDependentsComponentConstructorParams) {
    super();
    this.app = params.app;
    this.pluginId = params.pluginId;
  }

  /**
   * The enabled plugins that depend on this one, by name.
   *
   * @returns The dependents.
   */
  public getDependents(): PluginDependent[] {
    return [...this.dependents.values()].sort((a, b) => a.pluginName.localeCompare(b.pluginName));
  }

  public override onload(): void {
    this.registerEvent(this.app.workspace.on(PLUGIN_LOADED_EVENT_NAME, (payload) => {
      this.handlePluginLoaded(payload);
    }));
    this.registerEvent(this.app.workspace.on(PLUGIN_UNLOADED_EVENT_NAME, (payload) => {
      this.dependents.delete(payload.pluginId);
    }));
  }

  private handlePluginLoaded(payload: PluginLifecycleEventPayload): void {
    if (!payload.dependencyPluginIds.includes(this.pluginId)) {
      return;
    }

    this.dependents.set(payload.pluginId, {
      pluginId: payload.pluginId,
      pluginName: payload.pluginName,
      pluginVersion: payload.pluginVersion
    });
  }
}
