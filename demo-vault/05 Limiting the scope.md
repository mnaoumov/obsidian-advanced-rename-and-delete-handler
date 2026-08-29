# Limiting the scope

By default the plugin handles the whole vault. Two lists narrow that, for the parts of a vault where you would rather nothing happened automatically — a synced folder, an archive you want frozen, a directory another tool owns.

- `includePaths`
  - the only paths the plugin handles. Empty — the default — means the whole vault.
- `excludePaths`
  - paths the plugin leaves alone. An exclusion wins over an inclusion.

An entry is either a path from the vault root, or a `/regular expression/` between slashes. A path entry matches the folder and everything under it.

```code-button
---
caption: Leave the Archive folder alone
---
await require('/demoSetup.ts').changeSettings(app, { excludePaths: ['Archive'] });
```

With that set, move the target note into `Archive/` from [01 Renaming a note](<./01 Renaming a note.md>) and watch nothing follow it. Then put it back:

```code-button
---
caption: Handle the whole vault again (the default)
---
await require('/demoSetup.ts').changeSettings(app, { excludePaths: [] });
```

```code-button
---
caption: Put everything back where it started
---
await require('/demoSetup.ts').restoreVault(app);
console.log(require('/demoSetup.ts').printVaultTree(app));
```

Manual equivalent: edit **Include paths** and **Exclude paths** in the plugin's settings, one entry per line.

An excluded path is excluded on both sides of an operation. Renaming a note *inside* an excluded folder does nothing, and so does renaming a note elsewhere whose attachments would have to move into one.
