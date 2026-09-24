/**
 * @file
 *
 * Everything this plugin knows about Consistent Attachments and Links, which still ships its own copy of
 * the `delete-empty-folders` command this plugin owns.
 *
 * Both plugins register that id under the same English name. Obsidian namespaces command ids per plugin,
 * so nothing fails to register — the user simply sees the command twice, with nothing but the plugin name
 * to tell the copies apart, and running either one sweeps the vault again.
 *
 * That is annoying rather than destructive, so this is declared as a WARNING and both plugins keep
 * running — unlike the BLOCKING conflicts `Plugin.getPluginConflicts` declares beside it, which hold this
 * plugin's feature surface shut, because two rename/delete handlers acting on one rename corrupt links.
 */

/**
 * The versions of that plugin whose `delete-empty-folders` command overlaps with this plugin's.
 *
 * Bounded at BOTH ends, and each end is load-bearing:
 *
 * - Below `4.0.0` that plugin still owns a rename/delete handler, which the `Block` conflict
 *   `Plugin.getPluginConflicts` declares for the same plugin id already covers. Warning about the duplicated
 *   command as well would put two notices on screen for one plugin, the second of them about a command this
 *   plugin is not registering anyway, since its feature surface is shut.
 * - `4.1.0` is the release that gave the command up. It is a minor, not a major: a major of that plugin
 *   would also lift a version range Custom Attachment Location keys on, so the removal shipped without one.
 *   The bound therefore names the version rather than following semver.
 *
 * TODO: delete the declaration outright once every version that still registers the command is old enough
 * to have aged out.
 */
export const CONSISTENT_ATTACHMENTS_AND_LINKS_DELETE_EMPTY_FOLDERS_VERSION_RANGE = '>=4.0.0 <4.1.0';

/**
 * The plugin id, as listed in Obsidian's community plugin registry.
 */
export const CONSISTENT_ATTACHMENTS_AND_LINKS_PLUGIN_ID = 'consistent-attachments-and-links';

/**
 * The display name, used when telling the user which plugin the command is duplicated with.
 */
export const CONSISTENT_ATTACHMENTS_AND_LINKS_PLUGIN_NAME = 'Consistent Attachments and Links';
