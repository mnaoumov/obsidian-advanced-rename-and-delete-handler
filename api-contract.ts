/**
 * @file
 *
 * The runtime half of this plugin's published API: its CONTRACT, one entry per method of
 * {@link AdvancedRenameAndDeleteHandlerApi}, each with a schema over the argument list and a schema over the
 * value the method returns (awaited, for the methods that return a promise).
 *
 * This plugin publishes exactly this constant with its API, and a consumer copies it beside `api.d.ts` and
 * passes it as the `contract` when it looks the API up, so both ends validate against ONE definition. The
 * plugin registry checks the payloads against it only while the `obsidian-lib:validate-plugin-api-payloads` debug
 * switch is on.
 *
 * Copying it takes one dependency beside `api.d.ts`: `@mnaoumov/typescript-lib` (`1.3.0` or later), which
 * carries the contract types, the {@link https://standardschema.dev | Standard Schema} builders and the guard
 * builders, in its `api-contract`, `type-guards` and `object-utils` entry points. What is left here is this API's
 * own constant and the guards for its own shapes. The constant is typed as
 * `TypedApiContract<AdvancedRenameAndDeleteHandlerApi>`, which checks every entry against its method's signature
 * and requires both schemas on each.
 *
 * It is not named `api.ts`: TypeScript would read `api.d.ts` as that file's own declarations.
 */

import type { TypedApiContract } from '@mnaoumov/typescript-lib/api-contract';
import type {
  PropertyTypeGuards,
  TypeGuard
} from '@mnaoumov/typescript-lib/type-guards';

import {
  BOOLEAN_GUARD,
  createApiContractSchemaBuilders,
  createExpectedTypeGuard,
  defineApiContract,
  STRING_GUARD,
  UNDEFINED_GUARD
} from '@mnaoumov/typescript-lib/api-contract';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import {
  isBoolean,
  isString,
  isStringArray,
  literalTypeGuard,
  objectTypeGuard,
  optionalTypeGuard
} from '@mnaoumov/typescript-lib/type-guards';

import type {
  AdvancedRenameAndDeleteHandlerApi,
  BulkOperation,
  BulkOperationEndEvent,
  BulkOperationEvent,
  BulkOperationListener,
  BulkOperationStartEvent,
  EmptyFolderBehavior,
  FileMove,
  HandedOverSettings,
  MigratableSettings,
  MigrateSettingsParams,
  MigrateSettingsResult,
  MoveManyParams
} from './api.d.ts';

/**
 * The type of {@link ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT}: one entry per method of
 * {@link AdvancedRenameAndDeleteHandlerApi}, each typed against that method's parameters and awaited return
 * value.
 */
export type AdvancedRenameAndDeleteHandlerApiContract = TypedApiContract<AdvancedRenameAndDeleteHandlerApi>;

const { createArgumentsSchema, createTypeGuardSchema } = createApiContractSchemaBuilders('advanced-rename-and-delete-handler');

/**
 * Accepts every value {@link EmptyFolderBehavior} can take. Typed as a record over the union so a member added to
 * it in `api.d.ts` fails to compile here until it is listed.
 */
const isEmptyFolderBehavior = literalTypeGuard<EmptyFolderBehavior>({
  Delete: true,
  DeleteWithEmptyParents: true,
  Keep: true
});

const SETTING_VALIDATORS: PropertyTypeGuards<HandedOverSettings> = {
  emptyFolderBehavior: isEmptyFolderBehavior,
  excludePaths: isStringArray,
  includePaths: isStringArray,
  notePriorities: isStringArray,
  shouldDeleteConflictingAttachments: isBoolean,
  shouldDeleteEmptyNoteFolders: isBoolean,
  shouldHandleDeletions: isBoolean,
  shouldHandleRenames: isBoolean,
  shouldRenameAttachmentFiles: isBoolean,
  shouldRenameAttachmentFolder: isBoolean,
  shouldRescueSharedAttachments: isBoolean,
  shouldUpdateFileNameAliases: isBoolean,
  treatAsAttachmentExtensions: isStringArray
};

const isHandedOverSettings = objectTypeGuard<HandedOverSettings>(SETTING_VALIDATORS);

/**
 * Mirrors how the plugin reads a proposal: a member that is absent or `undefined` is not proposed, and a key that
 * names no setting is ignored rather than refused. Derived from {@link SETTING_VALIDATORS} so a setting cannot be
 * validated one way when handed over and another when proposed.
 */
const isMigratableSettings = objectTypeGuard<MigratableSettings>(castTo<PropertyTypeGuards<MigratableSettings>>(
  Object.fromEntries(
    Object.entries(SETTING_VALIDATORS).map(([propertyName, typeGuard]) => [propertyName, optionalTypeGuard(castTo<TypeGuard<unknown>>(typeGuard))])
  )
));

const isMigrateSettingsParams = objectTypeGuard<MigrateSettingsParams>({
  proposedSettings: isMigratableSettings,
  sourcePluginId: isString
});

const isMigrateSettingsResult = objectTypeGuard<MigrateSettingsResult>({
  isApplied: isBoolean
});

const isFileMove = objectTypeGuard<FileMove>({
  newPath: isString,
  oldPath: isString
});

const isMoveManyParams = objectTypeGuard<MoveManyParams>({
  moves: (value: unknown): value is readonly FileMove[] => Array.isArray(value) && value.every((item) => isFileMove(item))
});

/**
 * A function is all the contract can check of a callback: what it does when called is the caller's business.
 */
function isBatchOperation(value: unknown): value is () => Promise<void> {
  return typeof value === 'function';
}

const PATH_GUARD = { ...STRING_GUARD, expected: 'a path' };

const isBulkOperation = literalTypeGuard<BulkOperation>({ moveMany: true, runInBatch: true });
const isBulkOperationStart = objectTypeGuard<BulkOperationStartEvent>({ isReplay: optionalTypeGuard(isBoolean), operation: isBulkOperation, phase: literalTypeGuard({ start: true }) });
const isBulkOperationEnd = objectTypeGuard<BulkOperationEndEvent>({ isSuccessful: isBoolean, operation: isBulkOperation, phase: literalTypeGuard({ end: true }) });

/**
The notification payload schema, shared by diagnostic consumers and the provider.
*/
export const BULK_OPERATION_EVENT_SCHEMA = createTypeGuardSchema(createExpectedTypeGuard(
  'a bulk operation event',
  (value: unknown): value is BulkOperationEvent => isBulkOperationStart(value) || isBulkOperationEnd(value)
));

function isBulkOperationListener(value: unknown): value is BulkOperationListener {
  return typeof value === 'function';
}

function isUnsubscribe(value: unknown): value is () => void {
  return typeof value === 'function';
}

/**
 * The contract this plugin publishes with {@link AdvancedRenameAndDeleteHandlerApi}, for a consumer to pass as
 * the `contract` when it looks the API up.
 */
export const ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT: AdvancedRenameAndDeleteHandlerApiContract = defineApiContract<
  AdvancedRenameAndDeleteHandlerApi
>({
  getSettings: {
    input: createArgumentsSchema([]),
    output: createTypeGuardSchema(createExpectedTypeGuard('the handed-over settings', isHandedOverSettings))
  },
  isPathIgnored: {
    input: createArgumentsSchema([PATH_GUARD]),
    output: createTypeGuardSchema(BOOLEAN_GUARD)
  },
  isTreatedAsAttachment: {
    input: createArgumentsSchema([PATH_GUARD]),
    output: createTypeGuardSchema(BOOLEAN_GUARD)
  },
  migrateSettings: {
    input: createArgumentsSchema([createExpectedTypeGuard('migrate settings params', isMigrateSettingsParams)]),
    output: createTypeGuardSchema(createExpectedTypeGuard('a migrate settings result', isMigrateSettingsResult))
  },
  moveMany: {
    input: createArgumentsSchema([createExpectedTypeGuard('move many params', isMoveManyParams)]),
    output: createTypeGuardSchema(UNDEFINED_GUARD)
  },
  runInBatch: {
    input: createArgumentsSchema([createExpectedTypeGuard('a function performing the renames', isBatchOperation)]),
    output: createTypeGuardSchema(UNDEFINED_GUARD)
  },
  subscribeBulkOperations: {
    input: createArgumentsSchema([createExpectedTypeGuard('a bulk operation listener', isBulkOperationListener)]),
    output: createTypeGuardSchema(createExpectedTypeGuard('an unsubscribe function', isUnsubscribe))
  }
});
