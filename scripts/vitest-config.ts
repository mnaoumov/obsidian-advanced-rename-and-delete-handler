import type { ObsidianPluginVitestConfigContext } from 'obsidian-dev-utils/script-utils/test-runners/vitest-config';
import type { TestProjectConfiguration } from 'vitest/config';

import { defineObsidianPluginVitestConfig } from 'obsidian-dev-utils/script-utils/test-runners/vitest-config';

/**
 * The screenshot-capture suites (T461-P21) that write
 * `images/screenshots/screenshot-*.png`.
 *
 * They are named `*.desktop-capture.` / `*.android-capture.` rather than
 * `*.desktop.` / `*.android.` so they match NONE of the standard project globs.
 * That keeps them out of `npm run test:integration` entirely — capturing is an
 * explicit operation (`npm run capture:screenshots`), not something every test
 * run does. Folding them into the standard projects would rewrite ten PNGs on
 * every run and dirty the tree mid-release.
 */
const DESKTOP_CAPTURE_TEST_FILES = 'src/**/*.desktop-capture.integration.test.ts';
const ANDROID_CAPTURE_TEST_FILES = 'src/**/*.android-capture.integration.test.ts';

/**
 * The AVD the mobile shots are taken on: 900x1600 at density 320, which is
 * exactly the size the community store asks for, so the capture needs no crop,
 * no rescale and no letterbox. The shared `obsidian_test` AVD is a Pixel 10 Pro
 * XL at 1344x2994 (~9:20) and cannot produce it; resizing that one at runtime
 * destroys the Appium session, because the display change recreates the
 * activity and with it the WebView the session is attached to.
 *
 * Needs one-time provisioning — see [[T461-P21]].
 */
const SCREENSHOT_AVD_NAME = 'obsidian_screenshots';

const APPIUM_URL = 'http://localhost:4723';

/**
 * This AVD is cold-booted and rarely used, so Obsidian's first layout on it is
 * far slower than on the well-warmed shared one; the 90s default expires while
 * it is still starting up.
 */
const LAYOUT_READY_TIMEOUT_IN_MILLISECONDS = 240_000;

/**
 * The demo-vault button suite. It drives a real desktop Obsidian like the desktop project, but opens
 * a copy of the in-repo `demo-vault/` rather than an empty vault — hence its own `globalSetup` — and
 * needs its own suffix so the desktop project does not also collect it and open it against a vault
 * with no notes in it.
 */
const DEMO_VAULT_TEST_FILES = 'src/**/*.demo-vault.integration.test.ts';

/**
 * One `it` per note runs every button in that note, and each button re-opens the note, walks the
 * preview to find itself and then waits up to 15s for a result. A note with a dozen buttons therefore
 * blows well past the desktop project's 30s default — which fails the whole note with a bare vitest
 * timeout instead of naming the button that actually misbehaved.
 */
const DEMO_VAULT_TIMEOUT_IN_MILLISECONDS = 600_000;

export const config = defineObsidianPluginVitestConfig({
  customProjects(context: ObsidianPluginVitestConfigContext): TestProjectConfiguration[] {
    return [
      {
        test: {
          ...context.desktop,
          include: [DESKTOP_CAPTURE_TEST_FILES],
          name: 'capture-screenshots:desktop'
        }
      },
      {
        test: {
          ...context.android,
          environmentOptions: {
            obsidianTransport: {
              appiumUrl: APPIUM_URL,
              avdName: SCREENSHOT_AVD_NAME,
              layoutReadyTimeoutInMilliseconds: LAYOUT_READY_TIMEOUT_IN_MILLISECONDS,
              type: 'obsidian-android-appium'
            }
          },
          include: [ANDROID_CAPTURE_TEST_FILES],
          name: 'capture-screenshots:android'
        }
      },
      {
        test: {
          ...context.desktop,
          globalSetup: ['./scripts/demo-vault-global-setup.ts'],
          include: [DEMO_VAULT_TEST_FILES],
          name: 'integration-tests:demo-vault',
          testTimeout: DEMO_VAULT_TIMEOUT_IN_MILLISECONDS
        }
      }
    ];
  },

  /*
   * Seeds `obsidian-dev-utils`' integration-test harness plugin alongside the plugin under test, so an
   * `evalInObsidian` closure reaches the whole library surface as `lib.<helper>` — `lib.lockResourceForPath`
   * and `lib.flushQueue` among them, which the suppression suites need to stage a foreign locked
   * transaction and to drain the handler's queue. Without it `lib` carries only the harness's own helpers.
   *
   * `integration-test-vitest-global-setup` REPLACES `obsidian-integration-testing/vitest-global-setup-plugin`
   * (it does everything that one does, plus the seeding) — listing both would create the vault twice.
   *
   * Edited here rather than per project because the context members are live: `customProjects` runs after
   * this and spreads `context.desktop` / `context.android`, so the capture projects inherit the same wiring.
   *
   * The two projects that bring their own `populate` keep their own `globalSetup`, which composes
   * `getIntegrationTestPluginPopulate()` in by hand instead: `integration-tests:demo-vault` populates the
   * demo vault, `integration-tests:desktop-performance` the two bulk-delete folders and the seeded
   * `shouldHandleDeletions`. Their `setupFiles` are still the shared pair.
   */
  editContext(context: ObsidianPluginVitestConfigContext): void {
    for (const project of [context.android, context.desktop, context.desktopPerformance]) {
      project.globalSetup = ['obsidian-dev-utils/integration-test-vitest-global-setup'];
      project.setupFiles = [
        'obsidian-integration-testing/vitest-setup',
        'obsidian-dev-utils/integration-test-setup'
      ];
    }

    context.desktopPerformance.globalSetup = ['./scripts/vitest-global-setup-performance.ts'];
  }
});
