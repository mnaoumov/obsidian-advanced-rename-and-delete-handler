import type {
  App as AppOriginal,
  PluginManifest
} from 'obsidian';

import { strictProxy } from 'obsidian-dev-utils/strict-proxy';
import {
  describe,
  expect,
  it
} from 'vitest';

import { findInstalledConflicts } from './conflicting-plugins.ts';

interface InstalledPlugin {
  readonly isEnabled?: boolean;
  readonly pluginId: string;
  readonly version: string;
}

const OCAL_ID = 'obsidian-custom-attachment-location';
const OCAAL_ID = 'consistent-attachments-and-links';

function createApp(installedPlugins: readonly InstalledPlugin[]): AppOriginal {
  const enabledPlugins = new Set<string>();
  const manifests = createEmptyManifests();

  for (const installedPlugin of installedPlugins) {
    manifests[installedPlugin.pluginId] = strictProxy<PluginManifest>({
      id: installedPlugin.pluginId,
      version: installedPlugin.version
    });
    if (installedPlugin.isEnabled ?? true) {
      enabledPlugins.add(installedPlugin.pluginId);
    }
  }

  return strictProxy<AppOriginal>({
    plugins: strictProxy<AppOriginal['plugins']>({
      enabledPlugins,
      manifests
    })
  });
}

/**
 * Builds a manifest record with a null prototype, so a missing key reads as `undefined` (plugin not
 * installed) rather than resolving up the prototype chain.
 *
 * @returns The empty record.
 */
function createEmptyManifests(): AppOriginal['plugins']['manifests'] {
  const manifests: AppOriginal['plugins']['manifests'] = {};
  Object.setPrototypeOf(manifests, null);
  return manifests;
}

const ALL_CONFLICTING_IDS = [
  OCAL_ID,
  OCAAL_ID,
  'better-markdown-links',
  'external-rename-handler',
  'frontmatter-markdown-links'
];

describe('the conflicting plugin table', () => {
  it('should cover the five plugins that shipped their own handler', () => {
    const app = createApp(ALL_CONFLICTING_IDS.map((pluginId) => ({ pluginId, version: '0.0.1' })));

    expect(findInstalledConflicts(app).map((conflict) => conflict.plugin.pluginId)).toEqual(ALL_CONFLICTING_IDS);
  });

  it('should give every entry a parseable minimum version', () => {
    const app = createApp(ALL_CONFLICTING_IDS.map((pluginId) => ({ pluginId, version: '0.0.1' })));

    for (const conflict of findInstalledConflicts(app)) {
      expect(conflict.plugin.minSupportedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('should name every entry for the user', () => {
    const app = createApp(ALL_CONFLICTING_IDS.map((pluginId) => ({ pluginId, version: '0.0.1' })));

    for (const conflict of findInstalledConflicts(app)) {
      expect(conflict.plugin.name).not.toBe('');
    }
  });
});

describe('findInstalledConflicts', () => {
  it('should find nothing in a vault with none of them installed', () => {
    expect(findInstalledConflicts(createApp([]))).toEqual([]);
  });

  it('should find nothing when every installed version is new enough', () => {
    const app = createApp([
      { pluginId: OCAL_ID, version: '12.0.0' },
      { pluginId: OCAAL_ID, version: '4.1.2' }
    ]);

    expect(findInstalledConflicts(app)).toEqual([]);
  });

  it('should report a plugin installed below its minimum version', () => {
    const app = createApp([{ pluginId: OCAL_ID, version: '11.10.0' }]);

    const conflicts = findInstalledConflicts(app);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.plugin.pluginId).toBe(OCAL_ID);
    expect(conflicts[0]?.installedVersion).toBe('11.10.0');
  });

  it('should report every conflicting plugin, in declaration order', () => {
    const app = createApp([
      { pluginId: OCAAL_ID, version: '3.35.4' },
      { pluginId: OCAL_ID, version: '11.10.0' }
    ]);

    expect(findInstalledConflicts(app).map((conflict) => conflict.plugin.pluginId)).toEqual([OCAL_ID, OCAAL_ID]);
  });

  it('should ignore an installed but disabled plugin', () => {
    const app = createApp([{ isEnabled: false, pluginId: OCAL_ID, version: '11.10.0' }]);

    expect(findInstalledConflicts(app)).toEqual([]);
  });

  it('should treat an unparseable version as conflicting', () => {
    const app = createApp([{ pluginId: OCAL_ID, version: 'not-a-version' }]);

    const conflicts = findInstalledConflicts(app);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.installedVersion).toBe('not-a-version');
  });

  it('should report an enabled plugin whose manifest is missing as an unknown version', () => {
    const app = strictProxy<AppOriginal>({
      plugins: strictProxy<AppOriginal['plugins']>({
        enabledPlugins: new Set([OCAL_ID]),
        manifests: createEmptyManifests()
      })
    });

    const conflicts = findInstalledConflicts(app);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.installedVersion).toBe('unknown');
  });

  it('should accept a prerelease of the minimum version as still too old', () => {
    const app = createApp([{ pluginId: OCAL_ID, version: '12.0.0-beta.1' }]);

    expect(findInstalledConflicts(app)).toHaveLength(1);
  });
});
