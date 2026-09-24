/**
 * @file
 *
 * This plugin's public cross-plugin API.
 *
 * A plugin that used to own a rename/delete handler of its own hands its settings over here at the release
 * that stops owning one: it proposes the values it held, this plugin shows the user what would change, and
 * the user approves, edits or declines. The proposal is a suggestion — this plugin owns the settings, so it
 * owns the dialog too, and the consumer never writes into another plugin's `data.json`.
 *
 * Handing the settings over is not the end of the consumer's interest in them: the same values drive
 * features of its own that have nothing to do with a rename or a delete. So the API also reads them back —
 * synchronously, live, and with the path and attachment matching handed over as predicates rather than as
 * arrays each consumer would re-match with its own bundled copy of the library.
 *
 * Published through the `obsidian-dev-utils` registry, so a consumer gets version negotiation, a handle that
 * is revoked when this plugin unloads, and a wait that ends when this plugin loads rather than a lookup that
 * returns `undefined` because it ran first.
 *
 * The shape is declared ONCE, in the repo-root `api.d.ts`, and re-exported here for the rest of `src`: that file is
 * the one a consumer copies, so it imports nothing, and a second declaration here would be a second copy to drift.
 * This module keeps only what has to exist at runtime — the contract and its version.
 */

import type { PluginApiContract } from 'obsidian-dev-utils/obsidian/plugin/plugin-api';

export type {
  AdvancedRenameAndDeleteHandlerApi,
  EmptyFolderBehavior,
  HandedOverSettings,
  MigratableSettings,
  MigrateSettingsParams,
  MigrateSettingsResult
} from '../api.d.ts';

/**
 * The contract this plugin publishes. It declares the method names; the payloads are checked as they are
 * written, by a converter that refuses a value of the wrong type rather than storing it.
 *
 * A consumer that wants schema validation at the boundary supplies its own contract to `watchPluginApi` —
 * the consumer's contract wins when it supplies one.
 */
export const PLUGIN_API_CONTRACT: PluginApiContract = {
  getSettings: {},
  isPathIgnored: {},
  isTreatedAsAttachment: {},
  migrateSettings: {}
};

/**
 * The version of the contract above — independent of the plugin's own version.
 *
 * `1.1.0` added the read-back members; that is purely additive, so consumers still ask for `'^1'`.
 */
export const PLUGIN_API_VERSION = '1.1.0';
