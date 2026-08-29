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
