# Start here

Welcome to the [Advanced Rename and Delete Handler](https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/) demo vault. Renaming a note in Obsidian updates the links pointing at it, but stops there: the attachments that belonged to that note stay where they were, and deleting a note leaves its attachments behind as orphans. This plugin takes over renaming and deleting for the whole vault, so files travel with the note they belong to and nothing is left stranded.

**Your first success:** the grey rectangle below with a caption on it is a **code button**. **Clicking it runs the code it contains**, and the result appears underneath it. The `</>` toggle beside the caption reveals the source, so you can always read what a button is about to do before you press it. Press this one — it prints the vault as it stands right now, and every other page uses the same button to show you what changed.

```code-button
---
caption: Show me the vault as it is now
---
console.log(require('/demoSetup.ts').printVaultTree(app));
```

You should see `Archive/`, `Notes/`, and a `_attachments` folder holding `picture.png`. Keep that shape in mind — the pages below move it around.

If a demo leaves the vault somewhere you did not intend, this puts the movable parts back:

```code-button
---
caption: Put everything back where it started
---
await require('/demoSetup.ts').restoreVault(app);
console.log(require('/demoSetup.ts').printVaultTree(app));
```

## Renaming and moving

- [01 Renaming a note](<./01 Renaming a note.md>) — links follow the note, and so do its attachments.

## Deleting

- [02 Deleting a note](<./02 Deleting a note.md>) — what happens to the files a deleted note owned, and to the folder it leaves empty.
- [03 Shared attachments](<./03 Shared attachments.md>) — an attachment two notes use, when one of them is deleted.

## Deciding what the plugin touches

- [04 What counts as a note](<./04 What counts as a note.md>) — why `.excalidraw.md` is a drawing, not a note.
- [05 Limiting the scope](<./05 Limiting the scope.md>) — confining the plugin to part of the vault.
