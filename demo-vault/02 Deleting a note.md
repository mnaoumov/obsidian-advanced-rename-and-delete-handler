# Deleting a note

Deleting a note in Obsidian deletes exactly that one file. Everything it owned — the images pasted into it, the folder they lived in — stays behind, referenced by nothing. This page turns that clean-up on and shows what it does.

Every option here is **off by default**, because each one deletes something. Read what a button does before pressing it; the `</>` toggle beside the caption shows you.

## Attachments only that note used

- `shouldHandleDeletions`
  - whether deleting a note also deletes the attachments only that note referenced. An attachment another note still points at is never deleted — that case is [03 Shared attachments](<./03 Shared attachments.md>).

```code-button
---
caption: Delete attachments along with their note
---
await require('/demoSetup.ts').changeSettings(app, { shouldHandleDeletions: true });
```

```code-button
---
caption: Leave attachments behind (the default)
---
await require('/demoSetup.ts').changeSettings(app, { shouldHandleDeletions: false });
```

Manual equivalent: toggle **Should handle deletions** in the plugin's settings.

## The folder left empty

Deleting the last file in a folder leaves the folder sitting there. What should happen to it is a matter of taste, so it is a choice rather than a toggle.

- `emptyFolderBehavior`
  - `Keep` leaves the empty folder alone — the default, and the only option that removes nothing. `Delete` removes the folder. `Delete with empty parents` removes it and then walks upward, removing any parent the deletion has just emptied as well.

```code-button
---
caption: Delete folders a deletion empties
---
await require('/demoSetup.ts').changeSettings(app, { emptyFolderBehavior: 'Delete' });
```

```code-button
---
caption: Keep empty folders (the default)
---
await require('/demoSetup.ts').changeSettings(app, { emptyFolderBehavior: 'Keep' });
```

Manual equivalent: pick a different **Empty folder behavior** in the plugin's settings.

## The folders that are already empty

The setting above only ever sees the folder a deletion has just emptied. A vault that has been in use for a while is usually carrying others — left by a deletion made before the setting was turned on, or by a move made outside Obsidian — and nothing goes looking for them.

The **Advanced Rename and Delete Handler: Delete empty folders** command is that look. It walks the whole vault, deepest folder first, so a folder holding nothing but empty folders goes in the same pass as its children.

It sweeps whatever **Empty folder behavior** is set to, `Keep` included. That setting decides the fate of a folder emptied *incidentally*, by a deletion you asked for something else; running this command is you naming the folders themselves. A command called `Delete empty folders` that quietly did nothing would be the more surprising answer.

What it does leave alone: any folder still holding a file — including a file you cannot see, such as a `.DS_Store` — and anything your include and exclude lists put out of the plugin's reach ([05 Limiting the scope](<./05 Limiting the scope.md>)). The folders go to your trash, wherever Obsidian is configured to put it, so a sweep can be undone.

```code-button
---
caption: Make some empty folders to find
---
await require('/demoSetup.ts').createEmptyFolders(app);
```

```code-button
---
caption: Sweep every empty folder in the vault
---
require('/demoSetup.ts').deleteEmptyFolders(app);
```

Manual equivalent: run **Advanced Rename and Delete Handler: Delete empty folders** from the Command Palette.

## When a moved attachment lands on an existing file

Moving a note can send an attachment into a folder that already holds a file of that name.

- `shouldDeleteConflictingAttachments`
  - whether the file already sitting at the destination is replaced. Off by default, in which case the arriving attachment is renamed instead and both files survive.

```code-button
---
caption: Replace a file at the destination
---
await require('/demoSetup.ts').changeSettings(app, { shouldDeleteConflictingAttachments: true });
```

```code-button
---
caption: Rename the arriving file instead (the default)
---
await require('/demoSetup.ts').changeSettings(app, { shouldDeleteConflictingAttachments: false });
```

Manual equivalent: toggle **Should delete conflicting attachments** in the plugin's settings.

## Putting the vault back

Deletions go to your trash, wherever Obsidian is configured to put it, so a note this page removes comes back from there rather than from a button.

```code-button
---
caption: Show me the vault as it is now
---
console.log(require('/demoSetup.ts').printVaultTree(app));
```
