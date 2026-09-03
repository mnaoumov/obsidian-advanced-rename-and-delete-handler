/**
 * @file
 *
 * Reads which folders an attachment-location plugin has designated as attachment units.
 *
 * Some attachments are really a directory tree rather than a file: a page saved from a browser sits next
 * to a `_files/` folder holding its images and stylesheets, an `.excalidraw` sits next to the images it
 * references. Rescuing only the linked file out of a deleted note's area leaves the rest behind, and the
 * attachment arrives broken.
 *
 * Which folders count is not this plugin's to decide — it is a setting of whichever plugin owns the
 * vault's attachment-path policy. So the designation is read off the seam that already carries exactly
 * that kind of answer: a member hung on the patched `Vault.getAvailablePathForAttachments`, alongside the
 * `extended` this plugin already resolves the attachment folder through. A missing member means nobody
 * published one, which is the same "no plugin owns this policy" answer `extended` itself gives.
 *
 * Reading it rather than mirroring the setting is the point: the publisher and this plugin then decide
 * from ONE answer. Two plugins deciding separately what a single attachment is would leave a folder kept
 * whole by one and torn apart by the other.
 */

import type { Vault } from 'obsidian';

/**
 * The attachment-unit-folder designation published on {@link Vault.getAvailablePathForAttachments}.
 *
 * TODO: drop this local declaration once `obsidian-dev-utils` declares `checkIsAttachmentUnitFolder` on
 * `GetAvailablePathForAttachmentsFunctionExtended` and this plugin consumes that release.
 */
export interface AttachmentUnitFolderDesignation {
  /**
   * Whether a folder path is designated as an attachment unit.
   *
   * @param folderPath - The vault-relative path of the folder.
   * @returns `true` if the folder is designated as an attachment unit, `false` otherwise.
   */
  checkIsAttachmentUnitFolder?(this: void, folderPath: string): boolean;
}

/**
 * Parameters for {@link checkIsAttachmentUnitFolder}.
 */
export interface CheckIsAttachmentUnitFolderParams {
  /**
   * The vault-relative path of the folder.
   */
  readonly folderPath: string;

  /**
   * The vault whose patched `getAvailablePathForAttachments` carries the designation.
   */
  readonly vault: Vault;
}

/**
 * Reads the designation an attachment-location plugin published on the vault.
 *
 * @param params - The parameters for checking the folder.
 * @returns `true` if the folder is designated as an attachment unit, `false` when it is not and when
 * nobody published a designation at all.
 */
export function checkIsAttachmentUnitFolder(params: CheckIsAttachmentUnitFolderParams): boolean {
  /*
   * Reached through `Reflect.get` because naming the method reads it unbound, and the method itself is
   * not what is wanted here — only the designation hung off it.
   */
  const designation = Reflect.get(params.vault, 'getAvailablePathForAttachments') as Partial<AttachmentUnitFolderDesignation> | undefined;
  return designation?.checkIsAttachmentUnitFolder?.(params.folderPath) ?? false;
}
