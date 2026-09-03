import type {
  App,
  TAbstractFile
} from 'obsidian';

import {
  Notice,
  TFolder
} from 'obsidian';
import { configureCommunityPlugin } from 'obsidian-dev-utils/obsidian/community-plugins';

const PLUGIN_ID = 'advanced-rename-and-delete-handler';

const TARGET_PATH = 'Notes/Target note.md';
const RENAMED_TARGET_PATH = 'Notes/Target note renamed.md';
const ARCHIVE_TARGET_PATH = 'Archive/Target note.md';

const ILLUSTRATED_PATH = 'Notes/Illustrated note.md';
const SHARED_PATH = 'Notes/Shares the picture.md';

// Deepest last, so each folder's parent already exists when it is created.
const EMPTY_FOLDER_PATHS = ['Leftovers', 'Leftovers/Deeper'];

interface DemoSettingsPatch {
  emptyFolderBehavior?: string;
  excludePaths?: string[];
  notePriorities?: string[];
  rescueAttachmentUsedByMultipleNotesMode?: string;
  shouldDeleteConflictingAttachments?: boolean;
  shouldHandleDeletions?: boolean;
  shouldHandleRenames?: boolean;
  shouldRenameAttachmentFiles?: boolean;
  shouldRenameAttachmentFolder?: boolean;
  shouldRescueSharedAttachments?: boolean;
  shouldUpdateFileNameAliases?: boolean;
  treatAsAttachmentExtensions?: string[];
}

/**
 * Applies a settings patch, live, through the plugin's own settings component.
 *
 * Manual equivalent: change the same option in **Settings -> Community plugins -> Advanced Rename and
 * Delete Handler**.
 *
 * @param app - The Obsidian app.
 * @param patch - The settings to change.
 */
export async function changeSettings(app: App, patch: DemoSettingsPatch): Promise<void> {
  await configureCommunityPlugin({
    app,
    pluginId: PLUGIN_ID,
    settings: patch
  });
  new Notice('Applied.');
}

/**
 * Creates a small tree of folders holding nothing, so the sweep below has something to find.
 *
 * A button has to make them because git cannot ship an empty folder, which is also why a vault that has
 * been in use for a while accumulates them without anyone noticing.
 *
 * Manual equivalent: create `Leftovers` and `Leftovers/Deeper` from the File Explorer, and put no file in
 * either.
 *
 * @param app - The Obsidian app.
 */
export async function createEmptyFolders(app: App): Promise<void> {
  for (const folderPath of EMPTY_FOLDER_PATHS) {
    if (!app.vault.getFolderByPath(folderPath)) {
      await app.vault.createFolder(folderPath);
    }
  }

  new Notice('Created. Read the tree below, then press the sweep button.');
}

/**
 * Runs the vault-wide sweep that removes every folder holding nothing.
 *
 * Manual equivalent: the **Advanced Rename and Delete Handler: Delete empty folders** entry in the
 * Command Palette.
 *
 * @param app - The Obsidian app.
 */
export function deleteEmptyFolders(app: App): void {
  /*
   * Checked rather than fired and forgotten: `executeCommandById` answers `false` for an id it does not
   * know, so a command renamed out from under this button would otherwise do nothing at all and still look
   * like it worked — including to the suite that clicks every button in this vault.
   */
  const wasCommandFound = app.commands.executeCommandById(`${PLUGIN_ID}:delete-empty-folders`);
  if (!wasCommandFound) {
    throw new Error('The Delete empty folders command is not registered. Is the plugin enabled?');
  }

  new Notice('Sweeping. Read the tree below once the progress notice goes away.');
}

/**
 * Deletes the note that owns the shared picture, leaving the other note still pointing at it.
 *
 * Manual equivalent: delete `Notes/Illustrated note.md` from the File Explorer.
 *
 * @param app - The Obsidian app.
 */
export async function deleteIllustratedNote(app: App): Promise<void> {
  const note = app.vault.getFileByPath(ILLUSTRATED_PATH);
  if (!note) {
    new Notice('Already deleted — press the restore button to bring it back.');
    return;
  }

  await app.fileManager.trashFile(note);
  new Notice('Deleted. Read the tree below to see what happened to the picture.');
}

/**
 * Moves the target note into `Archive/`, so its attachments travel with it.
 *
 * Manual equivalent: drag `Notes/Target note.md` onto the `Archive` folder in the File Explorer.
 *
 * @param app - The Obsidian app.
 */
export async function moveTargetToArchive(app: App): Promise<void> {
  const note = app.vault.getFileByPath(TARGET_PATH);
  if (!note) {
    new Notice('Not where it started — press the restore button first.');
    return;
  }

  await app.fileManager.renameFile(note, ARCHIVE_TARGET_PATH);
  new Notice('Moved. Read the tree below, and the links in the notes that point here.');
}

/**
 * Prints the vault as a tree, so the effect of a rename or a delete is visible rather than described.
 *
 * @param app - The Obsidian app.
 * @returns The tree, one path per line.
 */
export function printVaultTree(app: App): string {
  const lines: string[] = [];
  appendFolder(app.vault.getRoot(), '', lines);
  return lines.join('\n');
}

/**
 * Puts every note and folder this vault's buttons move back where it started.
 *
 * Manual equivalent: undo the rename, the move, and the deletion by hand.
 *
 * @param app - The Obsidian app.
 */
export async function restoreVault(app: App): Promise<void> {
  const restorations: [from: string, to: string][] = [
    [RENAMED_TARGET_PATH, TARGET_PATH],
    [ARCHIVE_TARGET_PATH, TARGET_PATH]
  ];

  for (const [from, to] of restorations) {
    const note = app.vault.getFileByPath(from);
    if (note) {
      await app.fileManager.renameFile(note, to);
    }
  }

  new Notice('Restored what could be moved back. A deleted note has to come back from your trash.');
}

/**
 * Renames the target note, so you can watch every link pointing at it get rewritten.
 *
 * Manual equivalent: rename `Notes/Target note.md` in the File Explorer.
 *
 * @param app - The Obsidian app.
 */
export async function renameTargetNote(app: App): Promise<void> {
  const note = app.vault.getFileByPath(TARGET_PATH);
  if (!note) {
    new Notice('Already renamed — press the restore button to put it back.');
    return;
  }

  await app.fileManager.renameFile(note, RENAMED_TARGET_PATH);
  new Notice('Renamed. Look at the links in the notes that point at it.');
}

/**
 * Reads the note that shares the picture, so you can see whether its embed still resolves.
 *
 * @param app - The Obsidian app.
 * @returns The note's content.
 */
export async function readSharingNote(app: App): Promise<string> {
  const note = app.vault.getFileByPath(SHARED_PATH);
  if (!note) {
    return 'The sharing note is missing.';
  }

  return await app.vault.read(note);
}

function appendFolder(folder: TFolder, indent: string, lines: string[]): void {
  for (const child of sortedChildren(folder)) {
    lines.push(`${indent}${child.name}${child instanceof TFolder ? '/' : ''}`);
    if (child instanceof TFolder) {
      appendFolder(child, `${indent}  `, lines);
    }
  }
}

function sortedChildren(folder: TFolder): TAbstractFile[] {
  return [...folder.children]
    .filter((child) => !child.name.startsWith('.') && child.name !== '_assets')
    .sort((a, b) => a.name.localeCompare(b.name));
}
