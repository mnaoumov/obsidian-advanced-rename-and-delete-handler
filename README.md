# Advanced Rename and Delete Handler

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/mnaoumov) [![GitHub release](https://img.shields.io/github/v/release/mnaoumov/obsidian-advanced-rename-and-delete-handler)](https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/releases) [![GitHub downloads](https://img.shields.io/github/downloads/mnaoumov/obsidian-advanced-rename-and-delete-handler/total)](https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/releases) [![Coverage: 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler)

[Obsidian](https://obsidian.md/) updates the links pointing at a note when you rename it, and stops there. The images you pasted into that note stay behind under the old name. Deleting the note leaves them behind entirely, referenced by nothing, in a folder named after something that no longer exists.

This plugin takes over renaming and deleting for the whole vault: links follow the note, the files it owns travel with it, and what a deletion leaves behind is cleaned up on terms you choose.

**It is the single owner of that behavior in a vault.** Several plugins used to carry their own copy of this handler, and two handlers acting on one rename corrupt links between them. Rather than compete, this plugin stands aside while one of them is enabled at a version that still owns its handler: it stays enabled and does nothing, and its settings tab says which plugin it is waiting for and what version to update to. Update that plugin and this one picks the work back up on its own — no restart, and nothing here to switch back on.

<!-- markdownlint-disable MD033 -->

<a href="https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/blob/HEAD/images/screenshots/screenshot-desktop-1.png"><img src="images/screenshots/screenshot-desktop-1.png" alt="Every rename and delete option, in one place" width="600"></a>

<details>
<summary>More screenshots</summary>

<div>
<a href="https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/blob/HEAD/images/screenshots/screenshot-desktop-2.png"><img src="images/screenshots/screenshot-desktop-2.png" alt="Rename a note and every link to it follows" width="600"></a>
<a href="https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/blob/HEAD/images/screenshots/screenshot-desktop-3.png"><img src="images/screenshots/screenshot-desktop-3.png" alt="One owner per vault, and it says so rather than fighting" width="600"></a>
<a href="https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/blob/HEAD/images/screenshots/screenshot-mobile-1.png"><img src="images/screenshots/screenshot-mobile-1.png" alt="Every rename and delete option, in one place" width="270"></a>
<a href="https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/blob/HEAD/images/screenshots/screenshot-mobile-2.png"><img src="images/screenshots/screenshot-mobile-2.png" alt="Rename a note and every link to it follows" width="270"></a>
</div>

</details>

<!-- markdownlint-enable MD033 -->

## Demo vault

**The documentation is a demo vault.** Every feature has a note that explains what it does and why you would want it, with buttons that perform the rename or the deletion and then print the vault as a tree, so you see the effect rather than read a description of it.

**[Start reading here](<./demo-vault/00 Start.md>)** — it is plain markdown, so it works on GitHub with nothing installed.

A copy of the vault ships with every release. You can access it via any of the following:

1. Running the **`Advanced Rename and Delete Handler`: Open demo vault** command.
2. Downloading `advanced-rename-and-delete-handler-demo-vault.zip` from the [Releases](https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/releases). It unzips into a single `advanced-rename-and-delete-handler-demo-vault-<version>` folder.
3. Browsing its source in [`demo-vault/`](./demo-vault/README.md) in this repository.

## What it does

- **Nothing, until you turn it on.** A fresh install leaves renames and deletions to Obsidian and says so once, with a button to the settings. Other plugins ask you to install this one, and being asked to install something should never change how your vault behaves. [01 Renaming a note](<./demo-vault/01 Renaming a note.md>)
- **It tells you which plugins need it.** Its settings tab lists the enabled plugins that declare this one as a dependency, each with a button to that plugin's own settings — the answer to "why is this in my vault" before you remove it.
- **Links follow a renamed or moved note**, including the display text of a link that was showing the old file name — while a link somebody gave their own words to is left alone. [01 Renaming a note](<./demo-vault/01 Renaming a note.md>)
- **Attachments travel with the note that owns them**, folder and all, when it is renamed or moved to another folder. [01 Renaming a note](<./demo-vault/01 Renaming a note.md>)
- **Deleting a note can clean up after it** — the attachments only that note used, and the attachment folders the deletion leaves empty, plus the note's own folder if you ask for it. Off by default, because each option removes something. A **Delete empty folders** command sweeps the whole vault for the ones already sitting there, left by deletions made before you turned any of this on. [02 Deleting a note](<./demo-vault/02 Deleting a note.md>)
- **An attachment two notes share is never deleted with one of them**, and can be moved to the note that still uses it rather than left in a folder belonging to a note that is gone. When several notes could adopt it and your priority list settles nothing, the plugin names them and asks rather than guessing. An attachment that is really a folder — a `_files` tree, a drawing's sidecar folder — moves whole, when your attachment-location plugin says so. [03 Shared attachments](<./demo-vault/03 Shared attachments.md>)
- **An `Excalidraw` drawing is treated as an attachment, not a note**, whether it is stored as `.excalidraw.md` or as a plain `.md` carrying its `excalidraw-plugin` property, along with any other ending or `property:` match you add. [04 What counts as a note](<./demo-vault/04 What counts as a note.md>)
- **The plugin can be confined to part of the vault** with include and exclude path lists. [05 Limiting the scope](<./demo-vault/05 Limiting the scope.md>)

## Similar plugins

- [`Attachment Manager`](https://community.obsidian.md/plugins/attachment-manager) — the closest in scope: binds one attachment folder to each note's name, and renames or deletes that folder with the note; it also renames pasted images and can hide the folders, and it takes over two of Obsidian's own *Files and links* settings while enabled. This plugin works with whatever attachment layout your vault already has, and adds shared-attachment handling and include and exclude paths.
- [`Consistent Attachments`](https://community.obsidian.md/plugins/consistent-attachments) — moves or copies a note's attachments when the note moves to another folder, with a skip, copy or ask choice for shared ones, and scans for orphaned and misplaced attachments; it does not act on deletions.
- [`Note Folder Autorename`](https://community.obsidian.md/plugins/note-folder-autorename) — turns a note into a folder note and moves or renames the folder whenever the note moves or is renamed; it follows that one folder, not the attachments a note links.
- [`Move Files`](https://community.obsidian.md/plugins/move-files) — a command that gathers every file the open note links into a `<note> files` folder and updates the links; it runs on request, not on rename.
- [`Delete Note and Attachments`](https://github.com/mandavap/obsidian-delete-note-and-attachments) (not in the community directory) — a context-menu entry that deletes a note together with its embedded attachments, after a dialog that shows which ones another note still uses; an ordinary deletion is left alone.
- [`Strip Images`](https://community.obsidian.md/plugins/strip-images) — removes every image embed from one note on request and trashes the images no other note references; the note itself stays.
- [`Media Archive`](https://community.obsidian.md/plugins/media-archive) — sends deleted media to an archive folder instead of the trash, refuses to archive media a note still uses, and moves unused uploads there on its own; it manages two fixed folders rather than each note's attachments.
- [`Unlink on Delete`](https://community.obsidian.md/plugins/unlink-on-delete) — when a file is deleted, rewrites the links that pointed at it into plain text; this plugin cleans up files a deletion leaves behind, not links.
- [`Remove Empty Assets`](https://community.obsidian.md/plugins/remove-empty-assets) — removes empty folders inside your attachment folders, on startup, on a schedule, or after a note or attachment is deleted; it does not delete attachments themselves.
- [`Remove Empty Folders`](https://community.obsidian.md/plugins/remove-empty-folders) — a file-explorer action that removes the empty folders under the selected folders, one level per run; this plugin's **Delete empty folders** command sweeps the whole vault, deepest first, in one pass.
- [`File Bundles`](https://community.obsidian.md/plugins/file-bundles) — lets a file declare the files and folders that belong to it, and moves, renames, duplicates or deletes them as one locked bundle; the grouping is declared per file, where this plugin derives it from links and the attachment folder.

Last searched for similar plugins on 2026-10-26.

## For plugin developers

This plugin publishes an API for the plugins that used to handle renames and deletions themselves and no longer do: they propose the settings they held so a vault keeps behaving the way it did, and go on reading those settings back afterwards. Its types are in [`api.d.ts`](./api.d.ts) at the root of this repository — it imports nothing at all, so copy it into your plugin as it is.

Beside it, [`api-contract.ts`](./api-contract.ts) holds the published API's contract, `ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT`: for every method, a schema over its arguments and a schema over what it returns. It is the constant this plugin publishes with the API, so copy it next to `api.d.ts` and pass it as the `contract`, and both sides check the same definition. Its schemas are [Standard Schema](https://standardschema.dev) objects built with [`@mnaoumov/typescript-lib/api-contract`](https://www.npmjs.com/package/@mnaoumov/typescript-lib), which carries the generic half (the contract types, the schema builders and the guard builders, in its `api-contract`, `type-guards` and `object-utils` entry points), so copying it means adding that package (`npm install @mnaoumov/typescript-lib`, `1.3.0` or later). Apart from that package, the file imports only `./api.d.ts`. (It is not named `api.ts`: TypeScript would read `api.d.ts` as that file's own declarations.)

This plugin owns those settings, so it owns the dialog too: your proposal is shown next to the current values, and the user approves, edits or declines it row by row. Nothing is written unless they press OK.

The API is published through the `@mnaoumov/obsidian-lib` cross-plugin registry, which gives you version negotiation, a handle that is revoked when this plugin unloads, and a wait that ends when this plugin loads — rather than a lookup that returns `undefined` because it ran first. The contract version is `1.2.0` and moves independently of the plugin's own version; ask for `'^1'`.

If your plugin already uses [`@mnaoumov/obsidian-lib`](https://mnaoumov.dev/obsidian-lib/guides/cross-plugin-apis/), `watchPluginApi` is the whole of it:

```ts
import { watchPluginApi } from '@mnaoumov/obsidian-lib/plugin/plugin-api';

import type { AdvancedRenameAndDeleteHandlerApi } from './api.d.ts';

import { ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT } from './api-contract.ts';

const ref = watchPluginApi<AdvancedRenameAndDeleteHandlerApi>({
  apiVersionRange: '^1',
  app: this.app,
  component: this,
  contract: ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT,
  pluginId: 'advanced-rename-and-delete-handler'
});

const api = await ref.whenAvailable();
const result = await api.migrateSettings({
  proposedSettings: {
    shouldHandleRenames: true,
    treatAsAttachmentExtensions: ['.excalidraw.md']
  },
  sourcePluginId: this.manifest.id
});

if (result.isApplied) {
  // Record your own one-shot flag, so the offer is not repeated.
}
```

- **`proposedSettings`** names only what you held. Every member is optional, and a proposal that matches what this plugin already holds is dropped rather than shown, so a user is never asked about a row that would change nothing.
- **`result.isApplied`** is `false` when the user cancelled and nothing was written — do NOT record your migration as done in that case. It is `true` when they approved, and also when the proposal changed nothing and no dialog was needed.
- **The call resolves only once the dialog is closed**, so awaiting it is how you learn the answer. Two plugins proposing at once are queued, never stacked.
- **A value of the wrong type is refused** rather than written, so a mistake surfaces as an error instead of a corrupted `data.json`.
- The settings you may propose are the members of `HandedOverSettings` in [`api.d.ts`](./api.d.ts), each documented there.

If your plugin does not use `@mnaoumov/obsidian-lib` — and is not going to — you still need no dependency on anything. The registry, and the two events a plugin announces itself through, are a documented wire protocol reachable with the `obsidian` module alone; [Plugin API protocol](https://mnaoumov.dev/obsidian-lib/guides/plugin-api-protocol/) is that route written out, and `api.d.ts` types it just as well, since nothing in that file imports the library either. Look the API up each time you use it rather than keeping it in a field: the raw object does not know when this plugin has unloaded.

### Reading the settings back

Handing the settings over does not end your interest in them: the same values drive features of your own that have nothing to do with a rename or a delete. Rather than keeping a shadow copy, read them from here.

All three members are **synchronous**, so you can call them from a `checkCallback(isChecking)`, a settings row's `disabled` / `visible` predicate, or a loop over vault files — none of which can `await`. Hold the ref, not the API object, and read `ref.value` each time: it is `null` before this plugin loads and after it unloads, and correct again on a re-enable.

```ts
const ref = watchPluginApi<AdvancedRenameAndDeleteHandlerApi>({
  apiVersionRange: '^1',
  app: this.app,
  component: this,
  contract: ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT,
  pluginId: 'advanced-rename-and-delete-handler'
});

// Inside a `checkCallback`, a `visible` predicate, or a loop over vault files.
const api = ref.value;
if (api && !api.isPathIgnored(file.path) && !api.isTreatedAsAttachment(file.path)) {
  const { emptyFolderBehavior, notePriorities } = api.getSettings();
  // ...
}
```

- **`getSettings()`** returns every setting you may propose, as plain data, read live on every call, so there is nothing to invalidate and nothing to subscribe to. The arrays are copies — writing to one changes nothing here.
- **`isPathIgnored(path)`** answers whether this plugin leaves the path alone, per the include and exclude lists.
- **`isTreatedAsAttachment(path)`** answers whether the path names an attachment despite its extension, by an ending such as `.excalidraw.md` or a `property:` entry matched against its frontmatter. A Markdown file Obsidian has not indexed yet matches no `property:` entry.
- **Use the two predicates rather than re-matching the arrays yourself.** Every plugin bundles its own copy of `@mnaoumov/obsidian-lib`, so running the lists through your copy of the matching code is two copies that can drift apart; asking here keeps the matching in one place.
- These arrived in contract `1.1.0`, and `shouldDeleteEmptyNoteFolders` in `getSettings()` in `1.2.0`. Both are purely additive, so `'^1'` still gets you them — but a vault running an older release will hand you an API without them, which is what `watchPluginApi`'s shape check is for.

### Declaring this plugin as a dependency

If your plugin cannot work without this one, say so rather than failing quietly once a user removes it. With `@mnaoumov/obsidian-lib`'s `PluginBase`, declare it and your `onloadImpl` does not run until this plugin is installed, enabled and new enough — your plugin explains what is missing and installs it in one click, and finishes loading the moment it arrives:

```ts
protected override getPluginDependencies(): PluginDependency[] {
  return [
    {
      apiVersionRange: '^1.1.0',
      pluginId: 'advanced-rename-and-delete-handler',
      pluginName: 'Advanced Rename and Delete Handler',
      reason: 'Moves each note\'s attachment folder with it when the note is renamed.'
    }
  ];
}
```

Your plugin then appears in this plugin's settings tab under **Plugins that depend on this one**. Because this plugin does nothing until something is turned on, asking a user to install it is harmless; hand your old values over with `migrateSettings` (above) for the switches your users relied on.

## Installation

The plugin is available in [the official Community Plugins repository](https://community.obsidian.md/plugins/advanced-rename-and-delete-handler).

### Beta versions

To install the latest beta release of this plugin (regardless if it is available in [the official Community Plugins repository](https://community.obsidian.md) or not), follow these steps:

1. Ensure you have the [BRAT plugin](https://community.obsidian.md/plugins/obsidian42-brat) installed and enabled.
2. Click [Install via BRAT](https://intradeus.github.io/http-protocol-redirector?r=obsidian://brat?plugin=https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler).
3. An Obsidian pop-up window should appear. In the window, click the `Add plugin` button once and wait a few seconds for the plugin to install.

## Debugging

By default, debug messages for this plugin (id: `advanced-rename-and-delete-handler`) are hidden.

If you need to enable them refer to the [documentation](https://mnaoumov.dev/obsidian-lib/guides/debugging/).

## Changelog

All notable changes to this project will be documented in the [CHANGELOG](./CHANGELOG.md).

## Contributing

Contributions are welcome — see [CONTRIBUTING](./CONTRIBUTING.md) to get set up.

## Support

<!-- markdownlint-disable MD033 -->

<a href="https://www.buymeacoffee.com/mnaoumov" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="60" width="217"></a>

<!-- markdownlint-enable MD033 -->

## My other Obsidian resources

[See my other Obsidian resources](https://github.com/mnaoumov/obsidian-resources).

## License

© [Michael Naumov](https://github.com/mnaoumov/)
