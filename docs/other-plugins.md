# Living with other plugins

## One owner per vault

Several plugins used to carry their own copy of this rename and delete handler, and two handlers acting on one rename corrupt links between them. So this plugin is the single owner of that behavior in a vault.

Rather than compete, it stands aside while one of those plugins is enabled at a version that still owns its handler. It stays enabled and does nothing, and its settings tab says which plugin it is waiting for and what version to update to. Update that plugin and this one picks the work back up on its own — no restart, and nothing here to switch back on.

## Plugins that depend on this one

Other plugins, such as `Custom Attachment Location` and `Consistent Attachments and Links`, ask you to install this one. Being asked to install something should never change how your vault behaves, which is why every behavior here is off until you turn it on.

The settings tab lists the enabled plugins that declare this one as a dependency, each with a button to that plugin's own settings — the answer to "why is this in my vault" before you remove it.

A plugin that handed its old settings over offers them through a dialog, which shows each proposed value next to the current one. You approve, edit or decline each row, and nothing is written unless you press OK. How a plugin does that is in [Plugin API](./plugin-api.md).
