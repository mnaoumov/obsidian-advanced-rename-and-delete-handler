# Shared attachments

An attachment that two notes use has no single owner. Deleting one of those notes must not take the picture with it, but leaving the picture in a folder belonging to a note that no longer exists is its own kind of mess. This page is about that second half.

Two notes share one image: [Illustrated note](<./Notes/Illustrated note.md>), whose folder the picture lives in, and [Shares the picture](<./Notes/Shares the picture.md>), which embeds the same file.

## The picture survives regardless

Deleting the owner never deletes an attachment another note still points at, whatever the settings say. Turn deletion handling on and try it:

```code-button
---
caption: Turn deletion handling on
---
await require('/demoSetup.ts').changeSettings(app, { shouldHandleDeletions: true });
```

```code-button
---
caption: Delete the note that owns the picture
---
await require('/demoSetup.ts').deleteIllustratedNote(app);
console.log(require('/demoSetup.ts').printVaultTree(app));
```

Open [Shares the picture](<./Notes/Shares the picture.md>): the image still renders. The picture is still there because that note still references it.

## Where the survivor should live

By default the picture stays exactly where the deleted note had put it — in a folder named after a note that is now gone. Turning the rescue on moves it into the attachment folder of the note that still uses it.

- `shouldRescueSharedAttachments`
  - whether a surviving attachment is moved into the adopting note's attachment folder, rather than left behind.

```code-button
---
caption: Move survivors to the note that still uses them
---
await require('/demoSetup.ts').changeSettings(app, { shouldRescueSharedAttachments: true });
```

```code-button
---
caption: Leave survivors where they are (the default)
---
await require('/demoSetup.ts').changeSettings(app, { shouldRescueSharedAttachments: false });
```

Manual equivalent: toggle **Should rescue shared attachments** in the plugin's settings.

Where "the adopting note's attachment folder" actually is depends on your vault. The plugin asks Obsidian, so a vault running an attachment-location plugin gets that plugin's answer and a plain vault gets the folder configured in **Settings -> Files and links**.

## When more than one note survives

With a single surviving note there is nothing to decide. With several, the plugin needs to be told which one wins, and by default it is told nothing — so it leaves the attachment alone rather than guessing.

- `notePriorities`
  - an ordered list, highest priority first. An entry is an extension such as `.md`, a `property:name=value` match against a note's frontmatter, or a `/regular expression/`. An empty list, or a tie between two notes of equal rank, means the attachment stays put.

```code-button
---
caption: Prefer plain notes over drawings
---
await require('/demoSetup.ts').changeSettings(app, { notePriorities: ['.md', '.excalidraw.md'] });
```

```code-button
---
caption: Express no preference (the default)
---
await require('/demoSetup.ts').changeSettings(app, { notePriorities: [] });
```

Manual equivalent: edit **Note priorities** in the plugin's settings, one entry per line.

Deciding a tie silently would move a file the user never named, on a rule they never wrote. Leaving it where it is at least keeps the vault where they last saw it.
