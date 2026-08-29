/**
 * @file
 *
 * Detects other plugins that still run a rename/delete handler of their own.
 *
 * Five plugins shipped their own copy of this handler, from `obsidian-dev-utils`. Two handlers acting on
 * one rename corrupts links and moves attachments twice, and there is no reliable way for this plugin to
 * win that race: the library elects a handler by registry order, but its `runAsyncLinkUpdate` patch is
 * outside that election, so whichever plugin loaded first keeps a hand on the wheel. Every scheme for
 * seizing control from inside is therefore load-order dependent.
 *
 * So this plugin does not compete. It checks the installed versions, and if any of them still owns a
 * handler it refuses to run and says which plugins need updating. Refusing is deterministic where
 * competing is not, and a vault that briefly has no handler is a far better outcome than one with two.
 *
 * The check reads versions rather than the registry on purpose: a plugin that has not loaded yet has
 * registered nothing, so asking the registry would give a different answer depending on when it was
 * asked.
 */

import type { App } from 'obsidian';

import { lt } from 'semver';

/**
 * A plugin that used to own its own rename/delete handling.
 */
export interface ConflictingPlugin {
  /**
   * The first version that no longer registers a handler of its own, and is therefore safe to run
   * alongside this plugin.
   */
  readonly minSupportedVersion: string;

  /**
   * The display name, used when telling the user what to update.
   */
  readonly name: string;

  /**
   * The plugin id, as listed in Obsidian's community plugin registry.
   */
  readonly pluginId: string;
}

/**
 * A conflicting plugin found installed at a version that still owns a handler.
 */
export interface InstalledConflict {
  /**
   * The version currently installed.
   */
  readonly installedVersion: string;

  /**
   * What was expected of it.
   */
  readonly plugin: ConflictingPlugin;
}

/*
 * TODO: [[T646-P21]] — the minimum versions are the NEXT major of each plugin, chosen because dropping a
 * plugin's own rename/delete settings is a breaking change for it. None of these releases exists yet.
 * Pin each one to its real version as that plugin ships, and drop the entry entirely once the version
 * that still conflicts is old enough to have aged out.
 */
const CONFLICTING_PLUGINS: readonly ConflictingPlugin[] = [
  {
    minSupportedVersion: '12.0.0',
    name: 'Custom Attachment Location',
    pluginId: 'obsidian-custom-attachment-location'
  },
  {
    minSupportedVersion: '4.0.0',
    name: 'Consistent Attachments and Links',
    pluginId: 'consistent-attachments-and-links'
  },
  {
    minSupportedVersion: '5.0.0',
    name: 'Better Markdown Links',
    pluginId: 'better-markdown-links'
  },
  {
    minSupportedVersion: '4.0.0',
    name: 'External Rename Handler',
    pluginId: 'external-rename-handler'
  },
  {
    minSupportedVersion: '3.0.0',
    name: 'Frontmatter Markdown Links',
    pluginId: 'frontmatter-markdown-links'
  }
];

/**
 * Finds the installed plugins that still own a rename/delete handler.
 *
 * Only ENABLED plugins count. A plugin that is installed but switched off registers nothing, so it
 * cannot conflict, and refusing to run because of it would be a false alarm the user cannot act on
 * except by uninstalling something they have already disabled.
 *
 * A version that cannot be parsed is treated as conflicting. Failing closed is the safe direction: the
 * cost of a false alarm is a notice, the cost of a false all-clear is a corrupted vault.
 *
 * @param app - The Obsidian app instance.
 * @returns The conflicts found, in the order they are declared.
 */
export function findInstalledConflicts(app: App): InstalledConflict[] {
  const conflicts: InstalledConflict[] = [];

  for (const plugin of CONFLICTING_PLUGINS) {
    if (!app.plugins.enabledPlugins.has(plugin.pluginId)) {
      continue;
    }

    const installedVersion = app.plugins.manifests[plugin.pluginId]?.version ?? '';
    if (isSupportedVersion(installedVersion, plugin.minSupportedVersion)) {
      continue;
    }

    conflicts.push({
      installedVersion: installedVersion || 'unknown',
      plugin
    });
  }

  return conflicts;
}

function isSupportedVersion(installedVersion: string, minSupportedVersion: string): boolean {
  try {
    return !lt(installedVersion, minSupportedVersion);
  } catch {
    return false;
  }
}
