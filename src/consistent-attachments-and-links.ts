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
 * running — unlike {@link conflicting-plugins!findInstalledConflicts}, which refuses outright, because two
 * rename/delete handlers acting on one rename corrupt links.
 */

/**
 * The versions of that plugin whose `delete-empty-folders` command overlaps with this plugin's.
 *
 * Bounded at BOTH ends, and each end is load-bearing:
 *
 * - Below `4.0.0` that plugin still owns a rename/delete handler, which
 *   {@link conflicting-plugins!findInstalledConflicts} already refuses to run beside. Warning about the
 *   duplicated command as well would put two notices on screen for one plugin, the second of them about a
 *   command this plugin is not registering anyway, since it is not running.
 * - `5.0.0` is that plugin's next major, and dropping a user-facing command is a breaking change for it,
 *   so the release that gives the command up cannot be a minor. Nothing below it has shipped that removal
 *   yet.
 *
 * TODO: pin the upper bound to the real version once that release exists, and delete the declaration
 * outright once every version that still registers the command is old enough to have aged out.
 */
export const CONSISTENT_ATTACHMENTS_AND_LINKS_DELETE_EMPTY_FOLDERS_VERSION_RANGE = '>=4.0.0 <5.0.0';

/**
 * The plugin id, as listed in Obsidian's community plugin registry.
 */
export const CONSISTENT_ATTACHMENTS_AND_LINKS_PLUGIN_ID = 'consistent-attachments-and-links';

/**
 * The display name, used when telling the user which plugin the command is duplicated with.
 */
export const CONSISTENT_ATTACHMENTS_AND_LINKS_PLUGIN_NAME = 'Consistent Attachments and Links';
