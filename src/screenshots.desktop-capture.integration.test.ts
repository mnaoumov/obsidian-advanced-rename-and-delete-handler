/**
 * @file
 *
 * Produces the desktop screenshots the community-store listing needs, driving staged notes in a real
 * Obsidian and writing `images/screenshots/screenshot-desktop-N.png`.
 *
 * THREE shots:
 *
 * 1. The settings tab — every option this plugin owns, in one panel, which is the claim it is built
 *    around.
 * 2. The plugin's own notice after a rename, with the rewritten link on screen behind it. A rename is a
 *    process rather than a state, so the notice is what makes it visible in a single frame; the shot
 *    asserts the link actually moved rather than trusting the notice.
 * 3. The blocked notice, with a plugin installed that still owns its own rename/delete handler. It is
 *    the first thing a user with one of those installed will see.
 *
 * The blocked shot is LAST because it shuts the plugin's feature surface — nothing of that surface can be
 * captured afterwards. The plugin itself stays enabled and loaded, which is the point of the frame: it is
 * waiting for an update to the OTHER plugin, not broken and not switched off.
 *
 * **Shot 1 renders at all because the settings modal stays in the photographed window.** `app.setting` is
 * popout-capable, and left at Obsidian's default it opens the settings in a second Electron window that
 * `captureObsidianScreenshot` never photographs — a frame with no settings in it and no error to say so.
 * Nothing here has to arrange that any more: the harness writes `settingsPopoutWindow: false` into every
 * vault it owns, and this suite reaches its vault through `getTemporaryVault()`. See
 * `obsidian-integration-testing`'s `AGENTS.md`, **L48. Headless vault defaults**, for the mechanism and for
 * why the key is a default rather than a knob.
 *
 * There is deliberately no "before and after" pair. The interesting half of this plugin is what does NOT
 * happen — a link that never broke, an attachment that never stranded — and a frame of a vault that
 * looks correct proves nothing on its own.
 *
 * **This capture is byte-stable, and TWO separate things had to be fixed to make it so.**
 * `npm run capture:screenshots` used to rewrite shots 2 and 3 on every run of an unchanged plugin, which
 * read like inherent nondeterminism. It was not — it was two concrete causes, both measured 2026-09-03 and
 * both removed:
 *
 * 1. **Version drift, fixed by the pin.** The frames were photographed against whatever asar the harness
 *    happened to provision, and it had moved on to the Catalyst `obsidian-1.14.0.asar`, whose chrome
 *    left-aligns the breadcrumb and tightens the ribbon spacing, while the committed shots had been taken
 *    on the public line. Restoring them from git on each run rather than committing a recapture left that
 *    difference in place indefinitely. Pinning the project to `public-latest` made shots 2 and 3 reproduce
 *    their committed bytes exactly; `scripts/vitest-config.ts` holds the pin and the reasoning.
 * 2. **The editor caret, fixed by `blurEditor` in `shoot`.** With the pin in place shot 3 still moved
 *    occasionally, by exactly 33 pixels in a 1px-wide column at x=265, y=170..202 — the caret beside the
 *    heading, caught on the other half of its blink. See that function for why focus is dropped rather than
 *    the caret hidden.
 *
 * So a dirty `images/screenshots/` after a capture IS signal here, unlike in the sibling suite in
 * `obsidian-app-update-notifier`, whose frames carry a wall clock and genuine compression noise and where
 * the churn was accepted as unfixable. Two things move a frame, and both are worth seeing: this plugin's own
 * UI changed — the likelier of the two, and the reason to run a capture at all after a feature lands — or the
 * pinned Obsidian shipped a new public release and the listing is being re-photographed on it. Either way,
 * look at the frame before committing it, rather than reaching for `git checkout`.
 *
 * The first is not hypothetical: shipping no-op defaults and the first-load notice moved shots 1 and 2 while
 * this suite was not being run, so the committed pair went on describing a version of the plugin that no
 * longer existed. That is the same defect as photographing the wrong Obsidian, arriving from the other side.
 *
 * **What each `it` asserts is the real guard, and it is deliberately more than the shot needs to render.**
 * A capture that photographs a degraded frame and overwrites a good one passes silently otherwise: shot 1
 * checks all thirteen settings rows against its "every option" caption, shot 2 checks that the rewritten
 * link is in the ACTIVE file and not merely on disk, and shot 3 checks that the blocked notice names the
 * plugin that took over. Each one is a claim the frame makes to a store visitor.
 */

import {
  mkdirSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  captureObsidianScreenshot,
  evalInObsidian,
  labelScreenshot,
  readPngDimensions
} from 'obsidian-integration-testing';
import { getTemporaryVault } from 'obsidian-integration-testing/vitest-global-setup-plugin';
import {
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

interface BlockedProbe {
  readonly hasFeatureCommand: boolean;
  readonly isLoaded: boolean;
  readonly noticeText: string;
}

interface RenameProbe {
  readonly activeFilePath: null | string;
  readonly linkTextAfter: string;
  readonly noticeText: string;
}

interface SettingsProbe {
  readonly noticeText: string;
  readonly settingNames: string[];
}

const WIDTH_IN_PIXELS = 1200;
const HEIGHT_IN_PIXELS = 800;

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const CONFLICTING_PLUGIN_ID = 'obsidian-custom-attachment-location';
const CONFLICTING_PLUGIN_NAME = 'Custom Attachment Location';
const SOURCE_NOTE_PATH = 'Screenshots/Chapter one.md';
const TARGET_NOTE_PATH = 'Screenshots/Chapter two.md';
const RENAMED_TARGET_NOTE_PATH = 'Screenshots/Chapter two renamed.md';

const RENAME_NOTICE_TEXT = 'Updated';
const RENAMED_LINK_TEXT = 'renamed';
const BLOCKED_NOTICE_TEXT = 'does nothing while';
const FEATURE_COMMAND_ID = `${PLUGIN_ID}:delete-empty-folders`;

/**
 * The first-load notice, which every capture run meets and no frame here wants.
 *
 * `FirstLoadNoticeComponent` speaks once per vault, when there is no `data.json` to read — which is every
 * run of this suite, because a capture always starts on a temporary vault. It is shown `isPermanent`, so
 * unlike the rename notice it never clears itself, and it lands in the top-right corner: over the settings
 * panel that shot 1's caption promises, and over the very notice shot 2 exists to show. A store reader does
 * meet it, once, on an empty vault — but not stacked on top of these two views, which is what a permanent
 * toast nobody dismissed makes of them.
 *
 * So `beforeAll` dismisses it, exactly as clicking it would, and shots 1 and 2 assert it did not come back.
 * Shot 3 never sees it: the blocked path never reaches the component that shows it, and by then the first
 * load has written the file that makes "once" true anyway.
 */
const FIRST_LOAD_NOTICE_TEXT = 'doing nothing yet';

/**
 * Every row `PluginSettingsTab` builds, in the order it builds them.
 *
 * Shot 1's caption promises "Every rename and delete option, in one place", and asserting a couple of rows
 * out of thirteen leaves that caption able to go quietly false — a row that stops rendering would still
 * pass and still be photographed. The panel scrolls, so not all of these are in frame; the claim being
 * guarded is the tab's, not the viewport's.
 *
 * Matched with `arrayContaining` rather than for equality, because the probe reads every
 * `.setting-item-name` in the document and the settings modal's own search sidebar contributes rows of its
 * own.
 */
const EXPECTED_SETTING_NAMES = [
  'Should handle renames',
  'Should update file name aliases',
  'Should rename attachment folder',
  'Should rename attachment files',
  'Should delete conflicting attachments',
  'Should handle deletions',
  'Empty folder behavior',
  'Should rescue shared attachments',
  'Note priorities',
  'When several notes could adopt the attachment',
  'Treat as attachment extensions',
  'Include paths',
  'Exclude paths'
];

const IMAGES_DIRECTORY = join(process.cwd(), 'images', 'screenshots');

beforeAll(async () => {
  const vault = getTemporaryVault();

  /*
   * NEITHER staged note carries an H1, and that is the composition rather than an oversight. Obsidian's
   * inline title already renders the basename above the editor, so a `# Chapter one` line is a second copy
   * of it one line lower — which shots 2 and 3, both photographed on this source note, showed as `Chapter
   * one` stacked on `Chapter one`, and which reads to a store visitor as a rendering bug in this plugin.
   * It was invisible while the caret was in frame, because Live Preview kept the raw `#` visible beside it;
   * `blurEditor` removing the caret is what made the two lines render identically. The subject of both
   * frames is the rewritten link, not a heading.
   */
  vault.populate({
    [SOURCE_NOTE_PATH]: 'It continues in [Chapter two](<./Chapter two.md>).\n',
    [TARGET_NOTE_PATH]: 'The note the link points at.\n'
  });
  await vault.syncToDevice();

  await evalInObsidian({
    async callback({ app, lib: { waitUntil }, sourceNotePath }) {
      /*
       * Under the transport's ~30s per-closure cap, not at it. The whole closure is one transport call, so
       * the two budgets below are summed: 30_000 + 1000 put it 1000 ms PAST the cap, which is the one place
       * a number cannot be — the call is killed there and reported as a bare transport timeout naming the
       * harness. The vault was populated and synced before this call was made, so what the wait is for is the
       * index noticing two notes.
       */
      const SETTLE_TIMEOUT_IN_MILLISECONDS = 20_000;
      const SETTLE_DELAY_IN_MILLISECONDS = 1000;

      app.changeTheme('obsidian');

      await waitUntil({
        message: 'the staged notes to appear in the vault',
        predicate: () => Boolean(app.vault.getFileByPath(sourceNotePath)),
        timeoutInMilliseconds: SETTLE_TIMEOUT_IN_MILLISECONDS
      });

      // Otherwise Obsidian asks for confirmation through a modal, which a capture run cannot answer.
      app.vault.setConfig('alwaysUpdateLinks', true);
      app.workspace.leftSplit.collapse();

      /*
       * Every notice the load put on screen, which on a fresh vault is the permanent first-load one. Removed
       * rather than waited out: it has no timeout to wait out. The settle below doubles as its repaint, so
       * this costs the closure no extra budget, and shots 1 and 2 assert the corner is clear afterwards.
       */
      for (const noticeEl of document.querySelectorAll('.notice')) {
        noticeEl.remove();
      }

      await sleep(SETTLE_DELAY_IN_MILLISECONDS);
    },
    input: { sourceNotePath: SOURCE_NOTE_PATH },
    vaultPath: vaultPath()
  });
});

describe('desktop store screenshots', () => {
  it('1 - every option in one panel', async () => {
    const probe = await openSettingsTab();

    expect(probe.settingNames).toEqual(expect.arrayContaining(EXPECTED_SETTING_NAMES));

    /*
     * Nothing is toasting over the panel. Stricter than "not the first-load notice" on purpose: this frame
     * is the settings tab and nothing else, so ANY notice in it is a frame the caption does not describe.
     */
    expect(probe.noticeText).toBe('');
    await shoot(1, 'Every rename and delete option, in one place');
  });

  it('2 - the links it rewrote when a note was renamed', async () => {
    const probe = await renameTargetAndReadResult();

    // The notice is what makes a rename visible in a still; the link text is what proves it happened.
    expect(probe.noticeText).toContain(RENAME_NOTICE_TEXT);
    expect(probe.linkTextAfter).toContain(RENAMED_LINK_TEXT);

    // And the rename notice is the ONLY one — the first-load toast sat exactly where this one belongs.
    expect(probe.noticeText).not.toContain(FIRST_LOAD_NOTICE_TEXT);

    /*
     * The rewritten link has to be BEHIND the notice, or the frame is a toast over an unrelated view and
     * the caption is unsupported. Nothing else here checks what the capture is pointed at: the rename
     * would still succeed, and every assertion above would still pass, with the source note closed.
     */
    expect(probe.activeFilePath).toBe(SOURCE_NOTE_PATH);
    await shoot(2, 'Rename a note and every link to it follows');
  });

  it('3 - what it does when another plugin already owns renames', async () => {
    const probe = await installConflictAndReload();

    expect(probe.noticeText).toContain(BLOCKED_NOTICE_TEXT);

    // Naming the plugin that took over is the whole point of the notice, and of this frame.
    expect(probe.noticeText).toContain(CONFLICTING_PLUGIN_NAME);

    /*
     * Enabled-but-inert, and the frame's caption depends on BOTH halves. Still loaded, so a store reader
     * sees a plugin that is waiting rather than one that switched itself off; no feature command, so the
     * frame is not a notice over a plugin that went on working regardless.
     */
    expect(probe.isLoaded).toBe(true);
    expect(probe.hasFeatureCommand).toBe(false);
    await shoot(3, 'One owner per vault, and it says so rather than fighting');
  });
});

/**
 * Takes focus off the editor immediately before a capture, so no caret is in the frame.
 *
 * This is the one thing that kept the shots from being byte-stable once the Obsidian was pinned, and it is
 * a single column of pixels: shot 3 came back 33 pixels different across two runs of an unchanged plugin,
 * all of them in a 1px-wide vertical bar at x=265, y=170..202 — the caret beside the heading line, caught
 * on the other half of its blink. Whichever phase the shutter lands on is pure timing, so
 * roughly every other capture rewrote a PNG that was in every other respect identical. The staged note
 * carried an H1 then and does not now (see `beforeAll` for why), so those coordinates describe the frame
 * that measurement was taken on rather than the one this suite captures today.
 *
 * Blurring rather than hiding the caret with injected CSS: an editor that does not have focus is a state
 * Obsidian really renders and a reader really sees, where a focused editor with no caret is not. Nothing
 * else in any of the three frames depends on focus.
 *
 * @returns A {@link Promise} that resolves once focus is gone and the window has repainted.
 */
async function blurEditor(): Promise<void> {
  await evalInObsidian({
    async callback(): Promise<void> {
      const REPAINT_DELAY_IN_MILLISECONDS = 500;

      const focusedEl: unknown = document.activeElement;
      if (focusedEl instanceof HTMLElement) {
        focusedEl.blur();
      }

      await sleep(REPAINT_DELAY_IN_MILLISECONDS);
    },
    vaultPath: vaultPath()
  });
}

/**
 * Installs a stub under a conflicting plugin's id and reloads this plugin, so its blocked notice is on
 * screen.
 *
 * @returns The notice, whether this plugin is still loaded, and whether its feature surface ran.
 */
async function installConflictAndReload(): Promise<BlockedProbe> {
  return await evalInObsidian({
    async callback({
      app,
      conflictingPluginId,
      featureCommandId,
      lib: { waitUntil },
      pluginId
    }): Promise<BlockedProbe> {
      const RENDER_TIMEOUT_IN_MILLISECONDS = 20_000;
      const RESIZE_SETTLE_DELAY_IN_MILLISECONDS = 2000;
      const SETTLE_DELAY_IN_MILLISECONDS = 1500;

      // Let the previous shot's capture settle: the device-metrics override it sets and clears disturbs
      // anything opened too soon afterwards.
      await sleep(RESIZE_SETTLE_DELAY_IN_MILLISECONDS);

      const pluginFolder = `${app.vault.configDir}/plugins/${conflictingPluginId}`;
      await app.vault.adapter.mkdir(pluginFolder);
      /*
       * The manifest's `name` is NOT what the notice renders — `Plugin.getPluginConflicts()` carries its own
       * `pluginName` per entry and looks the plugin up by `id`. Verified 2026-09-03 by renaming this field
       * and re-running: the frame came back byte-identical. Only `id` and `version` matter, the latter
       * because it must fall inside that entry's `conflictingVersionRange` for the block to hold at all.
       */
      await app.vault.adapter.write(
        `${pluginFolder}/manifest.json`,
        JSON.stringify({
          author: 'test',
          description: 'A stub standing in for a version that still owns its own handler.',
          id: conflictingPluginId,
          minAppVersion: '0.0.1',
          name: 'Custom Attachment Location',
          version: '11.10.0'
        })
      );
      await app.vault.adapter.write(
        `${pluginFolder}/main.js`,
        'module.exports = class extends require("obsidian").Plugin {};'
      );

      await app.plugins.loadManifests();
      await app.plugins.enablePluginAndSave(conflictingPluginId);

      await app.plugins.disablePlugin(pluginId);
      await app.plugins.enablePlugin(pluginId);

      await waitUntil({
        message: 'the blocked notice to appear',
        predicate: () => document.body.textContent.includes('does nothing while'),
        timeoutInMilliseconds: RENDER_TIMEOUT_IN_MILLISECONDS
      });

      await sleep(SETTLE_DELAY_IN_MILLISECONDS);

      return {
        // Registered by `onloadImpl`, which the closed gate never runs — so this is the surface's absence.
        hasFeatureCommand: Object.hasOwn(app.commands.commands, featureCommandId),
        isLoaded: Object.hasOwn(app.plugins.plugins, pluginId),
        noticeText: [...document.querySelectorAll('.notice')].map((notice) => notice.textContent).join(' ')
      };
    },
    input: {
      conflictingPluginId: CONFLICTING_PLUGIN_ID,
      featureCommandId: FEATURE_COMMAND_ID,
      pluginId: PLUGIN_ID
    },
    vaultPath: vaultPath()
  });
}

/**
 * Opens this plugin's settings tab and reports the rows it rendered.
 *
 * @returns The names of the rendered settings.
 */
async function openSettingsTab(): Promise<SettingsProbe> {
  return await evalInObsidian({
    async callback({ app, lib: { waitUntil }, pluginId }): Promise<SettingsProbe> {
      const RENDER_TIMEOUT_IN_MILLISECONDS = 20_000;
      const OPEN_DELAY_IN_MILLISECONDS = 500;
      const SETTLE_DELAY_IN_MILLISECONDS = 1500;

      app.setting.open();
      await sleep(OPEN_DELAY_IN_MILLISECONDS);
      app.setting.openTabById(pluginId);

      await waitUntil({
        message: 'the settings tab to render its rows',
        predicate: () =>
          [...document.querySelectorAll('.setting-item-name')]
            .some((name) => name.textContent === 'Should handle renames'),
        timeoutInMilliseconds: RENDER_TIMEOUT_IN_MILLISECONDS
      });

      await sleep(SETTLE_DELAY_IN_MILLISECONDS);

      return {
        noticeText: [...document.querySelectorAll('.notice')].map((notice) => notice.textContent).join(' '),
        settingNames: [...document.querySelectorAll('.setting-item-name')].map((name) => name.textContent)
      };
    },
    input: { pluginId: PLUGIN_ID },
    vaultPath: vaultPath()
  });
}

/**
 * Renames the target note with the source note on screen, and reports the plugin's notice alongside the
 * rewritten link.
 *
 * @returns What the rename produced.
 */
async function renameTargetAndReadResult(): Promise<RenameProbe> {
  return await evalInObsidian({
    async callback({
      app,
      lib: { waitUntil },
      renamedTargetNotePath,
      sourceNotePath,
      targetNotePath
    }): Promise<RenameProbe> {
      /*
       * Under the transport's ~30s per-closure cap, not at it. The whole closure is one transport call, so
       * these three are summed over the five waits they cover — two settle delays, the rename race, and two
       * renders — and at 20_000 per render that came to 49 000, well past a cap the call would have been
       * killed at first. At 9000 it is 27 000. Both renders are this plugin's own rewrite of a single link in
       * a two-note vault, which lands in well under a second.
       */
      const RENAME_SETTLE_IN_MILLISECONDS = 6000;
      const RENDER_TIMEOUT_IN_MILLISECONDS = 9000;
      const SETTLE_DELAY_IN_MILLISECONDS = 1500;

      // The settings modal is still up from the previous shot.
      app.setting.close();
      await sleep(SETTLE_DELAY_IN_MILLISECONDS);

      const source = app.vault.getFileByPath(sourceNotePath);
      const target = app.vault.getFileByPath(targetNotePath);
      if (!source || !target) {
        throw new Error('The staged notes are missing from the vault.');
      }

      await app.workspace.getLeaf(false).openFile(source);

      await waitUntil({
        message: 'the link to resolve to the target',
        predicate: () => app.metadataCache.getBacklinksForFile(target).keys().length > 0,
        timeoutInMilliseconds: RENDER_TIMEOUT_IN_MILLISECONDS
      });

      const renamePromise = app.fileManager.renameFile(target, renamedTargetNotePath);
      await Promise.race([
        renamePromise.catch(() => {
          // Lingering `onCleanCache`; the effect is polled below.
        }),
        sleep(RENAME_SETTLE_IN_MILLISECONDS)
      ]);

      await waitUntil({
        message: 'the link to be rewritten',
        predicate: async () => {
          const content = await app.vault.read(source);
          return content.includes('renamed');
        },
        timeoutInMilliseconds: RENDER_TIMEOUT_IN_MILLISECONDS
      });

      await sleep(SETTLE_DELAY_IN_MILLISECONDS);

      return {
        activeFilePath: app.workspace.getActiveFile()?.path ?? null,
        linkTextAfter: await app.vault.read(source),
        noticeText: [...document.querySelectorAll('.notice')].map((notice) => notice.textContent).join(' ')
      };
    },
    input: {
      renamedTargetNotePath: RENAMED_TARGET_NOTE_PATH,
      sourceNotePath: SOURCE_NOTE_PATH,
      targetNotePath: TARGET_NOTE_PATH
    },
    vaultPath: vaultPath()
  });
}

/**
 * Captures the window, captions it, and writes it as
 * `images/screenshots/screenshot-desktop-<index>.png`.
 *
 * @param index - The 1-based listing position.
 * @param caption - The caption drawn across the bottom of the frame.
 */
async function shoot(index: number, caption: string): Promise<void> {
  await blurEditor();

  const bytes = await captureObsidianScreenshot({
    heightInPixels: HEIGHT_IN_PIXELS,
    vaultPath: vaultPath(),
    widthInPixels: WIDTH_IN_PIXELS
  });

  const labeled = await labelScreenshot(bytes, { text: caption });

  expect(readPngDimensions(labeled)).toStrictEqual({
    heightInPixels: HEIGHT_IN_PIXELS,
    widthInPixels: WIDTH_IN_PIXELS
  });

  mkdirSync(IMAGES_DIRECTORY, { recursive: true });
  writeFileSync(join(IMAGES_DIRECTORY, `screenshot-desktop-${String(index)}.png`), labeled);
}

function vaultPath(): string {
  return getTemporaryVault().path;
}
