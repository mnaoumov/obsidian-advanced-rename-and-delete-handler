# What counts as a note

Everything this plugin does starts with one question: is this file a note, or is it something a note owns? Extensions usually answer it, and sometimes they lie.

An Excalidraw drawing is usually stored as `.excalidraw.md`. By extension it is a note; by every other measure it is a picture that happens to be written in Markdown. Treating it as a note means the plugin would try to move *its* attachments around when it is renamed, and would never move it along with the note that embeds it.

- `treatAsAttachmentExtensions`
  - the entries that make a file an attachment regardless of what its extension would otherwise say. An entry is a file ending, or a `property:name` / `property:name=value` frontmatter match. Both `.excalidraw.md` and `property:excalidraw-plugin` are there by default: the second is how Excalidraw itself recognizes a drawing, so one saved as a plain `.md` still counts.

```code-button
---
caption: Also treat .canvas.md as an attachment
---
await require('/demoSetup.ts').changeSettings(app, { treatAsAttachmentExtensions: ['.excalidraw.md', 'property:excalidraw-plugin', '.canvas.md'] });
```

```code-button
---
caption: Back to the default
---
await require('/demoSetup.ts').changeSettings(app, { treatAsAttachmentExtensions: ['.excalidraw.md', 'property:excalidraw-plugin'] });
```

Manual equivalent: edit **Treat as attachment extensions** in the plugin's settings, one entry per line.

The match is on the end of the file name, not on the last dot, which is why `.excalidraw.md` works as an entry at all. A file called `diagram.excalidraw.md` matches; a file called `excalidraw.md` matches too, and a file called `notes.md` does not.

A `property:` entry reads the note's frontmatter from Obsidian's index, so it matches only Markdown files, and only once Obsidian has indexed them. Until then the file is a note, which is the side that moves and deletes less.

This setting also decides which note adopts a shared attachment, because a file that is not a note cannot adopt anything — see [03 Shared attachments](<./03 Shared attachments.md>).
