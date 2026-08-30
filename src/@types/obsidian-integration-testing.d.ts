/**
 * @file
 *
 * Activates `obsidian-dev-utils`' augmentation of the `obsidian-integration-testing` `Lib` interface, so an
 * `evalInObsidian` closure can reach the whole library surface as `lib.<helper>` — `lib.watchPluginApi`
 * among them.
 *
 * The runtime side is already registered by the published `obsidian-dev-utils/integration-test-setup`
 * endpoint; only the types need this reference. A `compilerOptions.types` entry naming the same path does
 * NOT work — it resolves without complaint but never brings the augmentation into the program.
 */

/// <reference types="obsidian-dev-utils/@types/obsidian-integration-testing" />

export {};
