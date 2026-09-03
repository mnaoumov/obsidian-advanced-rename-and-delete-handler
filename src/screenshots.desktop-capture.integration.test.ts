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
 * 3. The refusal notice, with a plugin installed that still owns its own rename/delete handler. It is
 *    the first thing a user with one of those installed will see.
 *
 * The refusal shot is LAST because it unloads the plugin — nothing can be captured of it afterwards.
 *
 * **The settings modal has to be forced out of its popout window, and without that nothing renders.**
 * `app.setting` is popout-capable: `shouldUsePopout()` returns `app.vault.getConfig('settingsPopoutWindow')`,
 * whose Obsidian default is `true`, and the popout branch runs whenever `Platform.canPopoutWindow` — so on
 * every desktop run and no mobile one. It opens a second Electron window, reassigns the `activeWindow` /
 * `activeDocument` globals to it, and `Modal.open()` appends the modal into THAT window's document.
 * Measured against a real Obsidian: after `open()` this document held exactly three `.setting-item-name`
 * rows, all of them the search sidebar's — so a `waitUntil` here could only ever time out, and
 * `captureObsidianScreenshot`, which photographs the main window, could only ever produce a frame with no
 * settings in it and no error to say so. Setting `settingsPopoutWindow` to `false` BEFORE `open()` is the
 * whole fix: `open()` then attaches `containerEl` to this document itself, so nothing needs pre-appending.
 *
 * An assert-only suite can dodge all of this by rendering the tab directly or querying
 * `settingTab.containerEl`, wherever it ended up — a screenshot cannot, because the pixels have to be in
 * the window being photographed. The `setConfig` call below and the cast it needs go away once the harness
 * writes the key into the temporary vault's `app.json` itself, beside the `alwaysUpdateLinks` it already
 * writes.
 *
 * There is deliberately no "before and after" pair. The interesting half of this plugin is what does NOT
 * happen — a link that never broke, an attachment that never stranded — and a frame of a vault that
 * looks correct proves nothing on its own.
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

interface RefusalProbe {
  readonly isLoaded: boolean;
  readonly noticeText: string;
}

interface RenameProbe {
  readonly linkTextAfter: string;
  readonly noticeText: string;
}

interface SettingsProbe {
  readonly settingNames: string[];
}

/**
 * Obsidian's vault config, reduced to the one key `obsidian-typings` does not declare. Its `ConfigItem`
 * union lists fifty keys and `settingsPopoutWindow` is not among them, so the call needs a cast until it
 * is.
 */
interface VaultWithPopoutConfig {
  setConfig(key: 'settingsPopoutWindow', shouldUsePopout: boolean): void;
}

const WIDTH_IN_PIXELS = 1200;
const HEIGHT_IN_PIXELS = 800;

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const CONFLICTING_PLUGIN_ID = 'obsidian-custom-attachment-location';
const SOURCE_NOTE_PATH = 'Screenshots/Chapter one.md';
const TARGET_NOTE_PATH = 'Screenshots/Chapter two.md';
const RENAMED_TARGET_NOTE_PATH = 'Screenshots/Chapter two renamed.md';

const IMAGES_DIRECTORY = join(process.cwd(), 'images', 'screenshots');

beforeAll(async () => {
  const vault = getTemporaryVault();

  vault.populate({
    [SOURCE_NOTE_PATH]: '# Chapter one\n\nIt continues in [Chapter two](<./Chapter two.md>).\n',
    [TARGET_NOTE_PATH]: '# Chapter two\n\nThe note the link points at.\n'
  });
  await vault.syncToDevice();

  await evalInObsidian({
    async callback({ app, lib: { waitUntil }, sourceNotePath }) {
      const SETTLE_TIMEOUT_IN_MILLISECONDS = 30_000;
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

      await sleep(SETTLE_DELAY_IN_MILLISECONDS);
    },
    input: { sourceNotePath: SOURCE_NOTE_PATH },
    vaultPath: vaultPath()
  });
});

describe('desktop store screenshots', () => {
  it('1 - every option in one panel', async () => {
    const probe = await openSettingsTab();

    expect(probe.settingNames).toContain('Should handle renames');
    expect(probe.settingNames).toContain('Empty folder behavior');
    await shoot(1, 'Every rename and delete option, in one place');
  });

  it('2 - the links it rewrote when a note was renamed', async () => {
    const probe = await renameTargetAndReadResult();

    // The notice is what makes a rename visible in a still; the link text is what proves it happened.
    expect(probe.noticeText).toContain('Updated');
    expect(probe.linkTextAfter).toContain('renamed');
    await shoot(2, 'Rename a note and every link to it follows');
  });

  it('3 - what it does when another plugin already owns renames', async () => {
    const probe = await installConflictAndReload();

    expect(probe.noticeText).toContain('Not running');
    expect(probe.isLoaded).toBe(false);
    await shoot(3, 'One owner per vault, and it says so rather than fighting');
  });
});

/**
 * Installs a stub under a conflicting plugin's id and reloads this plugin, so its refusal notice is on
 * screen.
 *
 * @returns The notice, and whether this plugin unloaded itself.
 */
async function installConflictAndReload(): Promise<RefusalProbe> {
  return await evalInObsidian({
    async callback({
      app,
      conflictingPluginId,
      lib: { waitUntil },
      pluginId
    }): Promise<RefusalProbe> {
      const RENDER_TIMEOUT_IN_MILLISECONDS = 20_000;
      const RESIZE_SETTLE_DELAY_IN_MILLISECONDS = 2000;
      const SETTLE_DELAY_IN_MILLISECONDS = 1500;

      // Let the previous shot's capture settle: the device-metrics override it sets and clears disturbs
      // Anything opened too soon afterwards.
      await sleep(RESIZE_SETTLE_DELAY_IN_MILLISECONDS);

      const pluginFolder = `${app.vault.configDir}/plugins/${conflictingPluginId}`;
      await app.vault.adapter.mkdir(pluginFolder);
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
        message: 'the refusal notice to appear',
        predicate: () => document.body.textContent.includes('Not running: these plugins'),
        timeoutInMilliseconds: RENDER_TIMEOUT_IN_MILLISECONDS
      });

      await sleep(SETTLE_DELAY_IN_MILLISECONDS);

      return {
        isLoaded: Object.hasOwn(app.plugins.plugins, pluginId),
        noticeText: [...document.querySelectorAll('.notice')].map((notice) => notice.textContent).join(' ')
      };
    },
    input: {
      conflictingPluginId: CONFLICTING_PLUGIN_ID,
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

      /*
       * The one step that makes this work, and it must come BEFORE `open()` — `shouldUsePopout()` is read
       * inside the call. Left at Obsidian's default the settings go into a second Electron window, taking
       * `activeWindow` / `activeDocument` with them, and this document never sees a row. The file header
       * records the mechanism and what was measured.
       */
      const vault: unknown = app.vault;
      (vault as VaultWithPopoutConfig).setConfig('settingsPopoutWindow', false);

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
      const RENAME_SETTLE_IN_MILLISECONDS = 6000;
      const RENDER_TIMEOUT_IN_MILLISECONDS = 20_000;
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
