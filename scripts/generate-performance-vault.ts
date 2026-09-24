import type { PopulateFilesParams } from 'obsidian-integration-testing';

import process from 'node:process';

/**
 * The plugin under test. Must match `manifest.json`'s `id`; the
 * `bulk-delete.desktop-performance.integration.test.ts` test enables/disables it by
 * this id and the seeded `data.json` lives under `.obsidian/plugins/<id>/`.
 */
export const PLUGIN_ID = 'advanced-rename-and-delete-handler';

/**
 * Folder whose notes are bulk-deleted while the plugin is ENABLED (with
 * `shouldHandleDeletions` on). Each deletion drives one expensive attachment-path
 * resolution through the delete handler, so the count of resolutions over this folder is
 * the bottleneck signature.
 */
export const PERFORMANCE_VAULT_PRIMARY_FOLDER = 'bulk-enabled';

/**
 * Folder whose notes are bulk-deleted while the plugin is DISABLED — the tripwire
 * baseline. With no delete handler registered, deleting these notes must trigger zero
 * attachment-path resolutions.
 */
export const PERFORMANCE_VAULT_BASELINE_FOLDER = 'bulk-disabled';

/**
 * How many notes each of the two folders holds. The bottleneck is per-deleted-note, so
 * total vault size is irrelevant — only this count drives the linear cost. Overridable
 * via `RENAME_DELETE_PERF_VAULT_NOTE_COUNT` for a quicker (smaller) or harsher (larger)
 * run.
 */
const DEFAULT_PERFORMANCE_VAULT_NOTE_COUNT = 200;
export const PERFORMANCE_VAULT_NOTE_COUNT = Number(process.env['RENAME_DELETE_PERF_VAULT_NOTE_COUNT']) || DEFAULT_PERFORMANCE_VAULT_NOTE_COUNT;

/**
 * Root of the notes the `rename-walk` suite renames a folder of. Kept apart from the two bulk-delete folders,
 * which that suite counts by folder.
 */
export const RENAME_WALK_ROOT_FOLDER = 'rename-walk';

/**
 * The folder the `rename-walk` suite renames, one note per entry of {@link RENAME_WALK_MOVED_NOTE_COUNT}.
 */
export const RENAME_WALK_MOVED_FOLDER = `${RENAME_WALK_ROOT_FOLDER}/moved`;

/**
 * The notes that link to every moved note by its full path, so each of their links goes stale when the folder
 * moves and only the handler's own backlink capture can bring it back.
 */
export const RENAME_WALK_HOLDERS_FOLDER = `${RENAME_WALK_ROOT_FOLDER}/holders`;

/**
 * How many notes the renamed folder holds: F in "a folder rename of F files". Large enough that walks
 * proportional to it (2F + 1 before the fix) cannot pass for a constant.
 */
export const RENAME_WALK_MOVED_NOTE_COUNT = 40;

/**
 * How many holder notes link to the moved notes.
 */
export const RENAME_WALK_HOLDER_COUNT = 5;

/**
 * Root of the `delete-walk` suite's fixture. Kept apart from the two bulk-delete folders, which that suite counts
 * by folder.
 */
export const DELETE_WALK_ROOT_FOLDER = 'delete-walk';

/**
 * The folder the `delete-walk` suite deletes: {@link DELETE_WALK_ATTACHMENT_COUNT} attachments a note outside it
 * embeds, plus one attachment nothing embeds.
 */
export const DELETE_WALK_DELETED_FOLDER = `${DELETE_WALK_ROOT_FOLDER}/deleted`;

/**
 * How many embedded attachments the deleted folder holds: A in "a folder delete of A attachments". Large enough
 * that walks proportional to it cannot pass for a constant.
 */
export const DELETE_WALK_ATTACHMENT_COUNT = 20;

/**
 * The note outside the deleted folder that embeds every attachment in it, so each is still used and survives.
 */
const DELETE_WALK_HOLDER = `${DELETE_WALK_ROOT_FOLDER}/holder.md`;

/**
 * How many unrelated notes, {@link RENAME_WALK_BACKGROUND_LINKS_PER_NOTE} links each, surround the renamed folder, so a whole-vault walk costs something
 * and the vault is not trivially small.
 */
const RENAME_WALK_BACKGROUND_NOTE_COUNT = 1000;

/**
 * How many links each background note holds.
 */
const RENAME_WALK_BACKGROUND_LINKS_PER_NOTE = 5;

/**
 * How far apart a background note's links land, so they cross the vault rather than forming short chains.
 */
const RENAME_WALK_BACKGROUND_LINK_STRIDE = 97;

/**
 * Plugin data seeded before Obsidian opens.
 *
 * `shouldHandleDeletions` is what `DeleteHandler.handle()` gates the attachment-folder resolution on, which is
 * the bulk-delete suite's expensive path. `shouldHandleRenames` is what makes the handler capture and rewrite
 * backlinks on a rename, which is what the `rename-walk` suite counts; the bulk-delete suite renames nothing, so
 * it is unaffected. This plugin has no backup warning that would revert either on load.
 */
const SEEDED_PLUGIN_DATA = {
  shouldHandleDeletions: true,
  shouldHandleRenames: true
};

/**
 * Builds the file map for the performance vault, written to disk by
 * `TemporaryVault.populate()` after the plugin is copied in but before Obsidian opens it. The
 * vault holds two folders of plain notes (one deleted with the plugin enabled, one with
 * it disabled) plus the seeded plugin `data.json`.
 *
 * @returns A map of vault-relative paths to content.
 */
export function generatePerformanceVault(): PopulateFilesParams {
  const files: PopulateFilesParams = {
    [`.obsidian/plugins/${PLUGIN_ID}/data.json`]: JSON.stringify(SEEDED_PLUGIN_DATA)
  };

  for (const folder of [PERFORMANCE_VAULT_PRIMARY_FOLDER, PERFORMANCE_VAULT_BASELINE_FOLDER]) {
    for (let noteIndex = 0; noteIndex < PERFORMANCE_VAULT_NOTE_COUNT; noteIndex++) {
      files[`${folder}/note-${String(noteIndex)}.md`] = `# Note ${String(noteIndex)}\n`;
    }
  }

  for (let noteIndex = 0; noteIndex < RENAME_WALK_BACKGROUND_NOTE_COUNT; noteIndex++) {
    const links = Array.from({ length: RENAME_WALK_BACKGROUND_LINKS_PER_NOTE }, (_, linkIndex) => {
      const targetIndex = (noteIndex + 1 + linkIndex * RENAME_WALK_BACKGROUND_LINK_STRIDE) % RENAME_WALK_BACKGROUND_NOTE_COUNT;
      return `[[background-${String(targetIndex)}]]`;
    }).join(' ');
    files[`${RENAME_WALK_ROOT_FOLDER}/background/background-${String(noteIndex)}.md`] = `${links}\n`;
  }

  const holderLinks: string[] = [];
  for (let noteIndex = 0; noteIndex < RENAME_WALK_MOVED_NOTE_COUNT; noteIndex++) {
    files[`${RENAME_WALK_MOVED_FOLDER}/moved-${String(noteIndex)}.md`] = `[[background-${String(noteIndex)}]]\n`;
    holderLinks.push(`[[${RENAME_WALK_MOVED_FOLDER}/moved-${String(noteIndex)}]]`);
  }

  for (let holderIndex = 0; holderIndex < RENAME_WALK_HOLDER_COUNT; holderIndex++) {
    files[`${RENAME_WALK_HOLDERS_FOLDER}/holder-${String(holderIndex)}.md`] = `${holderLinks.join('\n')}\n`;
  }

  const holderEmbeds: string[] = [];
  for (let attachmentIndex = 0; attachmentIndex < DELETE_WALK_ATTACHMENT_COUNT; attachmentIndex++) {
    const attachmentPath = `${DELETE_WALK_DELETED_FOLDER}/attachment-${String(attachmentIndex)}.png`;
    files[attachmentPath] = 'not really a png';
    holderEmbeds.push(`![[${attachmentPath}]]`);
  }
  // Nothing embeds this one, so a walk that visits every child deletes it.
  files[`${DELETE_WALK_DELETED_FOLDER}/unused.png`] = 'not really a png';
  files[DELETE_WALK_HOLDER] = `${holderEmbeds.join('\n')}\n`;

  return files;
}
