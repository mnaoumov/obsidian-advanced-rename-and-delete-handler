# Renaming a note

Renaming a note should not break anything that pointed at it, and should not leave its attachments behind under the old name. This page renames and moves a note so you can watch both happen.

Two notes are involved: [Target note](<./Notes/Target note.md>), which gets renamed, and [Points at the target](<./Notes/Points at the target.md>), which links to it twice.

## Links follow the note

Open [Points at the target](<./Notes/Points at the target.md>) in a second pane, then press this:

```code-button
---
caption: Rename the target note
---
await require('/demoSetup.ts').renameTargetNote(app);
console.log(require('/demoSetup.ts').printVaultTree(app));
```

Both links now point at `Target note renamed.md`. Notice what did **not** change: the second link still reads "the note this demo keeps moving", because that was text somebody wrote rather than the note's name.

```code-button
---
caption: Rename it back
---
await require('/demoSetup.ts').restoreVault(app);
console.log(require('/demoSetup.ts').printVaultTree(app));
```

Manual equivalent: rename `Notes/Target note.md` in the File Explorer, and rename it back afterwards.

- `shouldHandleRenames`
  - whether the plugin handles renames at all. This is the setting the whole plugin hangs off; with it off, Obsidian does its own link updating and nothing else on this page has any effect.
- `shouldUpdateFileNameAliases`
  - whether a link whose display text was just the old file name gets that text rewritten too. A link somebody gave their own words to is left alone either way — that is the difference you just saw between the two links.

Turn the alias rewriting off and rename again to see the first link keep the old name as its text:

```code-button
---
caption: Stop rewriting link text
---
await require('/demoSetup.ts').changeSettings(app, { shouldUpdateFileNameAliases: false });
```

```code-button
---
caption: Rewrite link text again (the default)
---
await require('/demoSetup.ts').changeSettings(app, { shouldUpdateFileNameAliases: true });
```

## Attachments travel with the note

Moving a note to another folder is a rename as far as Obsidian is concerned, and the files that belong to that note should go with it. The destination is `Archive/`, which already holds one note — [Kept](<./Archive/Kept.md>) — so the folder exists before anything moves into it.

```code-button
---
caption: Move the target note into Archive
---
await require('/demoSetup.ts').moveTargetToArchive(app);
console.log(require('/demoSetup.ts').printVaultTree(app));
```

```code-button
---
caption: Move it back out of Archive
---
await require('/demoSetup.ts').restoreVault(app);
console.log(require('/demoSetup.ts').printVaultTree(app));
```

Manual equivalent: drag `Notes/Target note.md` onto the `Archive` folder, and drag it back.

- `shouldRenameAttachmentFolder`
  - whether a note's own attachment folder moves and is renamed along with it. This applies when a note has a folder of its own — the arrangement plugins like Custom Attachment Location set up, where each note keeps its files in a folder named after it.
- `shouldRenameAttachmentFiles`
  - whether the attachment **files** are renamed too, so their names keep matching the note. Off by default: renaming a file the user named themselves is a bigger surprise than leaving it alone.

## Where this leaves Obsidian's own behavior

With `shouldHandleRenames` on, this plugin replaces Obsidian's link update rather than running beside it. That is why only one plugin in a vault may own rename handling, and why this one refuses to start when another plugin that also owns it is installed — it tells you which one, and starts on its own once you have updated it.
