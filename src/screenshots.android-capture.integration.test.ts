/**
 * @file
 *
 * Produces the mobile screenshots the community-store listing needs, driving a staged note in Obsidian
 * Mobile on a real Android emulator and writing `images/screenshots/screenshot-mobile-N.png`.
 *
 * TWO shots, the mobile half of the desktop set: the settings panel, and the plugin's notice after a
 * rename. The desktop set's third shot — the block — is not repeated here, because it says the same
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
 *
 * **There is no version pin here, unlike the desktop half.** `scripts/vitest-config.ts` pins
 * `capture-screenshots:desktop` to `public-latest`, because an unpinned run photographed whatever asar the
 * harness happened to provision and silently re-chromed the committed frames. Nothing
 * equivalent is available on this side: `ObsidianAndroidAppiumTransportOptions` exposes twenty options and
 * not one of them names a version — the app is simply whatever APK the AVD carries, changed by
 * rebuilding the AVD rather than by configuration.
 *
 * **These two shots ARE byte-stable on this host, and that is measured rather than assumed.** Three
 * consecutive runs on 2026-09-23, each booting a fresh `obsidian_screenshots` emulator and tearing it down
 * again, reproduced shot 1 byte for byte all three times and shot 2 byte for byte across the two runs that
 * shared its staging. So a moved PNG here is signal, exactly as it is on the desktop side: look at the frame
 * before reaching for `git checkout`. What is NOT pinned is the Obsidian, per the paragraph above, so the
 * first thing to rule out is the AVD's APK having moved. The caret is the second and has never yet appeared
 * in a frame here, which is why nothing equivalent to the desktop half's `blurEditor` is done — a phone
 * screenshot is taken with the editor unfocused already.
 *
 * **The record here used to say the opposite, and it was wrong in both halves.** It said the AVD wedged
 * during Appium session creation and that no Android capture run had reached a shot since. The committed
 * frames were produced by a run — `e9b0e87`, 2026-08-29 — and each of the three runs above booted the AVD
 * and finished in 87 to 167 seconds, cold. Nothing was done to the AVD to achieve that.
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
  pollInObsidian,
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
  readonly activeFilePath: null | string;
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
  readonly noticeText: string;
  readonly settingNames: string[];
}

const WIDTH_IN_PIXELS = 900;
const HEIGHT_IN_PIXELS = 1600;

const PLUGIN_ID = 'advanced-rename-and-delete-handler';
const SOURCE_NOTE_PATH = 'Screenshots/Chapter one.md';
const TARGET_NOTE_PATH = 'Screenshots/Chapter two.md';
const RENAMED_TARGET_NOTE_PATH = 'Screenshots/Chapter two renamed.md';

/**
 * The first-load notice, which every capture run meets and neither frame here wants.
 *
 * `FirstLoadNoticeComponent` speaks once per vault, when there is no `data.json` to read — which is every
 * run of this suite, because a capture always starts on a temporary vault. It is shown `isPermanent`, so
 * unlike the rename notice it never clears itself.
 *
 * **On a phone it does not merely overlap a corner, it DISPLACES the layout, which is why the desktop copy's
 * reasoning is not simply inherited.** Measured on the 2026-09-20 run that last rewrote these two frames: in
 * shot 1 the notice covered the panel title and the *Renames and moves* heading and pushed the rows down far
 * enough that *Should delete conflicting attachments* left the frame, under a caption promising every option
 * in one place; in shot 2 the note was gone from the frame altogether, leaving the rename notice, this one
 * below it, and black, under a caption promising a link that follows a rename. A 900-pixel-wide frame has no
 * corner to spare.
 *
 * So `beforeAll` dismisses it, exactly as clicking it would, and both shots assert it did not come back.
 */
const FIRST_LOAD_NOTICE_TEXT = 'doing nothing yet';

const IMAGES_DIRECTORY = join(process.cwd(), 'images', 'screenshots');

/**
 * The Node-side budget for `syncToDevice`'s push to land in the emulator's vault.
 *
 * Long because a cold AVD genuinely takes that; safe to be long because Node does the waiting, one short
 * `poll` at a time, rather than one `evaluate` that Appium would cap at ~30s.
 */
const SYNC_TIMEOUT_IN_MILLISECONDS = 60_000;

beforeAll(async () => {
  const vault = getTemporaryVault();

  /*
   * NEITHER staged note carries an H1, and that is the composition rather than an oversight. Obsidian's
   * inline title already renders the basename above the editor, so a `# Chapter one` line is a second copy
   * of it one line lower — which shot 2, photographed on this source note, showed as `Chapter one` stacked
   * on `Chapter one`, and which reads to a store visitor as a rendering bug in this plugin. The desktop
   * suite stages its own pair and dropped the same two headings for the same reason; there the repeat was
   * invisible until `blurEditor` took the caret out of the frame, because Live Preview keeps the raw `#`
   * visible beside a caret on that line. Nothing equivalent is done here and nothing needs to be: a mobile
   * frame has no caret in it, so the two lines rendered identically in every device capture this suite has
   * produced. The subject of the frame is the rewritten link, not a heading.
   */
  vault.populate({
    [SOURCE_NOTE_PATH]: 'It continues in [Chapter two](<./Chapter two.md>).\n',
    [TARGET_NOTE_PATH]: 'The note the link points at.\n'
  });
  await vault.syncToDevice();

  /*
   * The waiting for the push to land happens in NODE, and this is the one wait here that could not simply be
   * sized down instead. `syncToDevice` pushes the vault archive over adb and the emulator then has to notice
   * it; a minute is a real budget on a cold AVD, which is why 60_000 was written. But Appium caps a single
   * `evaluate` at ~30s and surfaces the cap as a bare `WebDriverError: script timeout` naming only
   * `AppiumTransport.evaluate` — so the old shape asked for twice what one call could ever be given, and on
   * exactly the slow device the budget was for it would have died blaming the harness. Node does the waiting
   * now, one short `poll` at a time, so the minute is honoured.
   */
  await pollInObsidian({
    input: { sourceNotePath: SOURCE_NOTE_PATH },
    poll({ app, sourceNotePath }): boolean {
      return Boolean(app.vault.getFileByPath(sourceNotePath));
    },
    start({ app }): void {
      app.changeTheme('obsidian');
    },
    timeoutInMilliseconds: SYNC_TIMEOUT_IN_MILLISECONDS,
    timeoutMessage: 'the staged notes never appeared in the vault',
    until: (hasArrived: boolean): boolean => hasArrived,
    vaultPath: vaultPath()
  });

  await evalInObsidian({
    async callback({ app }): Promise<void> {
      const SETTLE_DELAY_IN_MILLISECONDS = 1000;

      // Otherwise Obsidian asks for confirmation through a modal, which a capture run cannot answer.
      app.vault.setConfig('alwaysUpdateLinks', true);

      /*
       * Every notice the load put on screen, which on a fresh vault is the permanent first-load one. Removed
       * rather than waited out: it has no timeout to wait out. The settle below doubles as its repaint, so
       * this costs the closure no extra budget, and both shots assert the frame is clear afterwards.
       */
      for (const noticeEl of document.querySelectorAll('.notice')) {
        noticeEl.remove();
      }

      await sleep(SETTLE_DELAY_IN_MILLISECONDS);
    },
    vaultPath: vaultPath()
  });
});

describe('mobile store screenshots', () => {
  it('1 - every option in one panel', async () => {
    const probe = await openSettingsTab();

    expect(probe.settingNames).toContain('Should handle renames');

    /*
     * Nothing is toasting over the panel. Stricter than "not the first-load notice" on purpose: this frame is
     * the settings tab and nothing else, so ANY notice in it is a frame the caption does not describe.
     */
    expect(probe.noticeText).toBe('');
    await shoot(1, 'Every rename and delete option, in one place');
  });

  it('2 - the links it rewrote when a note was renamed', async () => {
    const probe = await renameTargetAndReadResult();

    expect(probe.noticeText).toContain('Updated');
    expect(probe.linkTextAfter).toContain('renamed');

    // And the rename notice is the ONLY one — the first-load toast stacked directly under it in this frame.
    expect(probe.noticeText).not.toContain(FIRST_LOAD_NOTICE_TEXT);

    /*
     * The rewritten link has to be BEHIND the notice, or the frame is a toast over nothing and the caption is
     * unsupported. Nothing else here checks what the capture is pointed at: the rename would still succeed,
     * and every assertion above would still pass, with no note on screen at all — which is precisely the
     * frame the 2026-09-20 run produced.
     */
    expect(probe.activeFilePath).toBe(SOURCE_NOTE_PATH);
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
      /*
       * Under the transport's ~30s per-closure cap, not at it. Appium gives one `evaluate` ~30s and reports
       * the cap as a bare `WebDriverError: script timeout` naming only `AppiumTransport.evaluate`, so the
       * three budgets below are summed against it: at 30_000 the render alone sat AT the cap and the closure
       * declared 32 000, which no run could ever have honoured. The tab renders from settings this plugin
       * already holds, so twenty seconds on a phone is generous.
       */
      const RENDER_TIMEOUT_IN_MILLISECONDS = 20_000;
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
       * Under the transport's ~30s per-closure cap, not at it. Five waits are summed here — two settle
       * delays, the rename race, and two renders — and at 30_000 per render that came to 71 000, more than
       * twice what Appium gives one `evaluate` before killing it and blaming the harness. At 8000 it is
       * 27 000. Both renders are this plugin's own rewrite of a single link in a two-note vault.
       */
      const RENAME_SETTLE_IN_MILLISECONDS = 8000;
      const RENDER_TIMEOUT_IN_MILLISECONDS = 8000;
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
  // needs no re-shoot.
  const labeled = await labelScreenshot(captured, { text: caption });

  mkdirSync(IMAGES_DIRECTORY, { recursive: true });
  writeFileSync(join(IMAGES_DIRECTORY, `screenshot-mobile-${String(index)}.png`), labeled);
}

function vaultPath(): string {
  return getTemporaryVault().path;
}
