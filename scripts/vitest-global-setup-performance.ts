import type { PopulateFilesParams } from 'obsidian-integration-testing';

import {
  getIntegrationTestPluginPopulate,
  OBSIDIAN_DEV_UTILS_INTEGRATION_TEST_PLUGIN_ID
} from 'obsidian-dev-utils/script-utils/test-runners/integration-test-plugin';
import { createSetup } from 'obsidian-integration-testing/vitest-global-setup-plugin';

import { generatePerformanceVault } from './generate-performance-vault.ts';

function populate(): PopulateFilesParams {
  return {
    ...generatePerformanceVault(),
    /*
     * This project brings its own `populate`, so it composes the harness plugin in by hand rather than
     * taking `obsidian-dev-utils/integration-test-vitest-global-setup` the way `integration-tests:desktop`
     * and `integration-tests:android` do — that module is itself a `createSetup` call, and listing it here
     * as well would create the vault twice.
     */
    ...getIntegrationTestPluginPopulate()
  };
}

/*
 * Vitest global setup for the `integration-tests:desktop-performance` project: it pre-populates the vault
 * with the two bulk-delete folders and the seeded plugin `data.json` via `TemporaryVault.populate()` before
 * Obsidian opens it, so the startup scan indexes everything in one pass.
 */
const { setup, teardown } = createSetup({
  enableCommunityPlugins: [OBSIDIAN_DEV_UTILS_INTEGRATION_TEST_PLUGIN_ID],
  populate
});

export {
  setup,
  teardown
};
