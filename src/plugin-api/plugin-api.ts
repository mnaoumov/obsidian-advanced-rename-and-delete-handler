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
 * Published through the `@mnaoumov/obsidian-lib` plugin API registry, so a consumer gets version negotiation, a handle that
 * is revoked when this plugin unloads, and a wait that ends when this plugin loads rather than a lookup that
 * returns `undefined` because it ran first.
 *
 * The shape is declared ONCE, in the repo-root `api.d.ts`, and re-exported here for the rest of `src`: that file is
 * the one a consumer copies, so it imports nothing, and a second declaration here would be a second copy to drift.
 * The contract is declared once too, in the repo-root `api-contract.ts`, for the same reason; this module
 * publishes it and keeps the contract version.
 */

import type { ApiContract } from '@mnaoumov/typescript-lib/api-contract';

import { ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT } from '../../api-contract.ts';

export type {
  AdvancedRenameAndDeleteHandlerApi,
  EmptyFolderBehavior,
  HandedOverSettings,
  MigratableSettings,
  MigrateSettingsParams,
  MigrateSettingsResult
} from '../../api.d.ts';

/**
 * The contract this plugin publishes: the repo-root `api-contract.ts` constant a consumer copies, so the
 * provider and its consumers validate against one definition. Assigning it here is also what checks that the
 * library-built schemas are Standard Schemas the registry accepts.
 */
export const PLUGIN_API_CONTRACT: ApiContract = ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT;

/**
 * The version of the contract above — independent of the plugin's own version.
 *
 * `1.1.0` added the read-back members and `1.2.0` the `shouldDeleteEmptyNoteFolders` setting; both are purely
 * additive, so consumers still ask for `'^1'`.
 */
export const PLUGIN_API_VERSION = '1.2.0';
