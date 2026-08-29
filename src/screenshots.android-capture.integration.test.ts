/**
 * @file
 *
 * Produces the mobile screenshots the community-store listing needs, driving a staged note in Obsidian
 * Mobile on a real Android emulator and writing `images/screenshots/screenshot-mobile-N.png`.
 *
 * TWO shots, the mobile half of the desktop set: the settings panel, and the plugin's notice after a
 * rename. The desktop set's third shot — the refusal — is not repeated here, because it says the same
 * thing at half the width and the store listing does not need it twice.
 *
 * **Opening the settings modal takes one extra step, and without it nothing renders.** `app.setting`
 * exists from startup but its `containerEl` is NOT in the document, and `open()` returns without
 * attaching it — so the modal builds into a detached tree and the captured document stays empty. Append
 * `containerEl` to `document.body` BEFORE calling `open()`. Attaching afterwards is too late: the
 * default tab has already been rendered into the detached container.
 *
 * There is no mobile equivalent of the desktop viewport override, so the capture is always the device's
 * own framebuffer, and the AVD is built at exactly 900x1600.
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

interface RenameProbe {
  readonly linkTextAfter: string;
  readonly noticeText: string;
}

/**
 * Obsidian's settings modal, reduced to the container `obsidian-typings` does not declare.
 */
interface SettingsModalWithContainer {
  containerEl: HTMLElement;
}

interface SettingsProbe {
  readonly settingNames: string[];
}

const WIDTH_IN_PIXELS = 900;
const HEIGHT_IN_PIXELS = 1600;

const PLUGIN_ID = 'advanced-rename-delete-handler';
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
      const SETTLE_TIMEOUT_IN_MILLISECONDS = 60_000;
      const SETTLE_DELAY_IN_MILLISECONDS = 1000;

      app.changeTheme('obsidian');

      await waitUntil({
        message: 'the staged notes to appear in the vault',
        predicate: () => Boolean(app.vault.getFileByPath(sourceNotePath)),
        timeoutInMilliseconds: SETTLE_TIMEOUT_IN_MILLISECONDS
      });

      // Otherwise Obsidian asks for confirmation through a modal, which a capture run cannot answer.
      app.vault.setConfig('alwaysUpdateLinks', true);

      await sleep(SETTLE_DELAY_IN_MILLISECONDS);
    },
    input: { sourceNotePath: SOURCE_NOTE_PATH },
    vaultPath: vaultPath()
  });
});

describe('mobile store screenshots', () => {
  it('1 - every option in one panel', async () => {
    const probe = await openSettingsTab();

    expect(probe.settingNames).toContain('Should handle renames');
    await shoot(1, 'Every rename and delete option, in one place');
  });

  it('2 - the links it rewrote when a note was renamed', async () => {
    const probe = await renameTargetAndReadResult();

    expect(probe.noticeText).toContain('Updated');
    expect(probe.linkTextAfter).toContain('renamed');
    await shoot(2, 'Rename a note and every link to it follows');
  });
});

/**
 * Opens this plugin's settings tab and reports the rows it rendered.
 *
 * @returns The names of the rendered settings.
 */
async function openSettingsTab(): Promise<SettingsProbe> {
  return await evalInObsidian({
    async callback({ app, lib: { waitUntil }, pluginId }): Promise<SettingsProbe> {
      const RENDER_TIMEOUT_IN_MILLISECONDS = 30_000;
      const OPEN_DELAY_IN_MILLISECONDS = 500;
      const SETTLE_DELAY_IN_MILLISECONDS = 1500;

      const settingsModal: unknown = app.setting;
      const containerEl = (settingsModal as SettingsModalWithContainer).containerEl;
      if (!document.body.contains(containerEl)) {
        document.body.append(containerEl);
      }

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
      const RENAME_SETTLE_IN_MILLISECONDS = 8000;
      const RENDER_TIMEOUT_IN_MILLISECONDS = 30_000;
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
 * Captures the device frame, captions it, and writes it as
 * `images/screenshots/screenshot-mobile-<index>.png`.
 *
 * @param index - The 1-based listing position.
 * @param caption - The caption drawn across the bottom of the frame.
 */
async function shoot(index: number, caption: string): Promise<void> {
  const captured = await captureObsidianScreenshot({ vaultPath: vaultPath() });

  /*
   * The AVD is 900x1600, so the device frame IS the store's size. Asserting it here is what keeps that
   * true: run this against any other AVD and it fails loudly instead of quietly shipping an off-spec
   * image.
   */
  expect(readPngDimensions(captured)).toStrictEqual({
    heightInPixels: HEIGHT_IN_PIXELS,
    widthInPixels: WIDTH_IN_PIXELS
  });

  // Captioned AFTER capture, so the frame stays an untouched device screenshot and rewording a label
  // Needs no re-shoot.
  const labeled = await labelScreenshot(captured, { text: caption });

  mkdirSync(IMAGES_DIRECTORY, { recursive: true });
  writeFileSync(join(IMAGES_DIRECTORY, `screenshot-mobile-${String(index)}.png`), labeled);
}

function vaultPath(): string {
  return getTemporaryVault().path;
}
