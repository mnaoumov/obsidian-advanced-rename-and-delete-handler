# Plugin API

This plugin publishes an API for the plugins that used to handle renames and deletions themselves and no longer do: they propose the settings they held so a vault keeps behaving the way it did, and go on reading those settings back afterwards. Its types are in [`api.d.ts`](../api.d.ts) at the root of this repository — it imports nothing at all, so copy it into your plugin as it is.

Beside it, [`api-contract.ts`](../api-contract.ts) holds the published API's contract, `ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT`: for every method, a schema over its arguments and a schema over what it returns. It is the constant this plugin publishes with the API, so copy it next to `api.d.ts` and pass it as the `contract`, and both sides check the same definition. Its schemas are [Standard Schema](https://standardschema.dev) objects built with [`@mnaoumov/typescript-lib/api-contract`](https://www.npmjs.com/package/@mnaoumov/typescript-lib), which carries the generic half (the contract types, the schema builders and the guard builders, in its `api-contract`, `type-guards` and `object-utils` entry points), so copying it means adding that package (`npm install @mnaoumov/typescript-lib`, `1.3.0` or later). Apart from that package, the file imports only `./api.d.ts`. (It is not named `api.ts`: TypeScript would read `api.d.ts` as that file's own declarations.)

This plugin owns those settings, so it owns the dialog too: your proposal is shown next to the current values, and the user approves, edits or declines it row by row. Nothing is written unless they press OK.

The API is published through the `@mnaoumov/obsidian-lib` cross-plugin registry, which gives you version negotiation, a handle that is revoked when this plugin unloads, and a wait that ends when this plugin loads — rather than a lookup that returns `undefined` because it ran first. The contract version is `1.2.0` and moves independently of the plugin's own version; ask for `'^1'`.

## Handing your settings over

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
- The settings you may propose are the members of `HandedOverSettings` in [`api.d.ts`](../api.d.ts), each documented there.

If your plugin does not use `@mnaoumov/obsidian-lib` — and is not going to — you still need no dependency on anything. The registry, and the two events a plugin announces itself through, are a documented wire protocol reachable with the `obsidian` module alone; [Plugin API protocol](https://mnaoumov.dev/obsidian-lib/guides/plugin-api-protocol/) is that route written out, and `api.d.ts` types it just as well, since nothing in that file imports the library either. Look the API up each time you use it rather than keeping it in a field: the raw object does not know when this plugin has unloaded.

## Reading the settings back

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

## Declaring this plugin as a dependency

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
