# CHANGELOG

## 3.5.1

Canvas text nodes keep their links when several embedded attachments are renamed, and attachments and links now follow renames that overlap.

### Fixed

- Renaming a canvas whose text nodes embed several attachments no longer breaks the text: every link in a node is rewritten in one pass, so tables and following links stay intact ([#10](https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/issues/10)).
- A note's attachments now move when `Folder notes` renames the note's folder while the note's own rename is still being processed ([#11](https://github.com/mnaoumov/obsidian-advanced-rename-and-delete-handler/issues/11)).
- A note that links a renamed file and is itself renamed while that rename is still being processed now has its links updated at its new path.
- Settings changed externally, for example by a sync tool, are no longer written back on reload, so two synced devices stop rewriting each other's `data.json`.

## 3.5.0

Other plugins can now observe bulk moves, and a failed batch no longer leaves links broken.

### New

- Plugin API contract 1.4.0 adds `subscribeBulkOperations`: start and end notifications around `moveMany` and `runInBatch`, including failed ones. The end notification waits for queued rename work and metadata parsing. A subscriber can unsubscribe at any time, provider reload clears subscriptions, and an observer's error never interrupts a move.

### Fixed

- When a `runInBatch` callback throws, the renames it already made are finished first: queued handlers drain, held backlinks are rewritten and moved notes' links are repaired, and only then is the original error rethrown.

### Documentation

- Issue attachments are optional and strongly encouraged, and the README links to the Obsidian resources page.

## 3.4.0

This release has 3 new features and 1 fix.

### New

- **empty-folders:** opt into the rmdir guard
- **api:** publish moveMany and runInBatch
- **rename:** rewrite broken HTML paths and warn about paths left in settings

### Fixed

- **api:** find moveMany's affected notes through the backlink index

## 3.3.0

This release has 1 improvement.

### Improved

- **rename:** narrow rename link snapshots and move many files at once

## 3.2.0

This release has 1 new feature and 3 documentation changes. 5 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- add a Report a bug command

### Documentation

- **readme:** point bug reports at the Report a bug command
- add issue-filing instructions for AI agents
- **readme:** combine related resources and plugin comparisons

## 3.1.1

This release has 1 fix and 1 documentation change. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- **rename:** keep a folder note's folder name as its link caption

### Documentation

- cut the README down to a landing page, detail moved into docs/

## 3.1.0

This release has 1 new feature and 1 documentation change. 3 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- \[FR\] Setting to turn off the "Updated N links in M files." notice (#8)

### Documentation

- **readme:** add a Similar plugins section

## 3.0.1

This release has 2 fixes and 5 documentation changes. 5 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Fixed

- **demo-vault:** keep one `CodeScript Toolkit` minVersion, the 15.0.0 floor
- update every link inside a multi-link frontmatter value on rename

### Documentation

- name `obsidian-lib` where comments said dev-utils
- shorten the debugging section
- **changelog:** name the issue each released entry resolved
- point the remaining `obsidian-dev-utils` mentions at `obsidian-lib`
- **readme:** lead the Debugging section with `Advanced Debug Mode`

## 3.0.0

This release has 1 breaking change and 1 documentation change. 5 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Breaking changes

- **settings:** match path entries case-insensitively, as globs or flagged regular expressions

### Documentation

- mark plugin names as code

## 2.3.0

This release has 1 new feature and 1 fix. 5 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- **delete:** add shouldDeleteEmptyNoteFolders, off by default

### Fixed

- **rename:** merge rewriting a folder's links past a note with unparseable frontmatter

## 2.2.1

This release has maintenance changes only. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

## 2.2.0

This release has 1 new feature and 1 fix. 3 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- **api:** merge shipping the API contract as a copyable api-contract.ts

### Fixed

- **ui:** merge showing plugin names as code

## 2.1.2

This release has 1 fix.

### Fixed

- **rename:** move a shared attachment with the last of its notes (re #5 - Batch-moving all referencing notes leaves shared attachments behind)

## 2.1.1

This release has 1 fix. 4 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Fixed

- **rename:** recognize `Advanced Metadata Cache` in the canvas gate

## 2.1.0

This release has 1 new feature and 1 fix. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- **settings:** *Treat as attachment extensions* accepts `property:name` and `property:name=value` entries, matched against a note's frontmatter, so an `Excalidraw` drawing saved as a plain `.md` is an attachment by its `excalidraw-plugin` property (`Custom Attachment Location` #90). The default is now `.excalidraw.md` plus `property:excalidraw-plugin`. **A list you already have saved is not changed:** to get the new behaviour, add `property:excalidraw-plugin` on its own line in the settings tab. A property entry matches a file only once Obsidian has indexed it.

### Fixed

- **conflicts:** stop warning about *Delete empty folders* on `Consistent Attachments and Links` 4.1.0, which no longer offers that command.

## 2.0.0

This release has 2 new features, 4 fixes, 2 improvements and 3 other changes.

### New

- the settings tab lists the plugins that depend on this one.
- warn when `Consistent Attachments and Links` 4.x also offers the Delete empty folders command.

### Fixed

- **ui:** tell same-named notes apart on the rescue dialog's buttons (#1).
- **rename:** a canvas whose text `node` embeds an attachment no longer holds the operation queue forever when moved.
- **rename:** link updates in canvases are applied without the *Update links* prompt while rename handling is on.
- **screenshots:** the store screenshots no longer show a toast or the note title twice.

### Improved

- **rename:** renaming a folder of notes no longer walks the whole vault twice per renamed file.
- **delete:** folder deletion answers its backlink checks from an index instead of walking the vault.

### Other changes

- **Breaking:** every behaviour is now off by default, including handling renames and renaming the attachment folder. Installing the plugin no longer changes how a vault behaves. A setting already saved keeps its value, but a behaviour you relied on as a 1.x default without ever saving it is now off: turn it back on in the settings tab. A one-time notice on first load says so.
- **Breaking:** when a conflicting plugin version is installed, this plugin stays enabled but inert and explains why in its settings tab, instead of disabling itself. It resumes as soon as the conflict is gone, with no restart.
- **Breaking (API):** the `api` getter on the plugin instance is removed. The API is published only through the plugin API registry, and its types are declared in the root `api.d.ts`.

## 1.3.0

This release has 3 new features, 2 documentation changes and 1 other change. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- add a manual vault-wide Delete empty folders command
- **rescue:** keep a designated attachment unit folder whole on delete
- **rescue:** ask which note adopts a tied attachment, instead of stalling

### Documentation

- **agents:** anchor the replayFolderDeletion reference to a symbol, not a line
- **agents:** correct the deviation note, and drop the dead field it would have documented

### Other changes

- **Behaviour change:** `rescueAttachmentUsedByMultipleNotesMode` now defaults to `Prompt`. Users who already enabled *Should rescue shared attachments* are asked which note adopts a tied attachment, instead of the rescue silently stalling.

## 1.2.0

This release has 1 new feature and 1 fix. 4 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- **api:** read the handed-over settings back, at contract 1.1.0

### Fixed

- **build:** wire build:compile to buildCompile and drop the duplicate leaf script

## 1.1.1

This release has 2 fixes. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- **deps:** move to `obsidian-integration-testing` 11 and `obsidian-dev-utils` 96.5.2
- **deps:** drop the brace-expansion file: override that breaks a clean install

## 1.1.0

This release has 1 new feature.

### New

- **api:** offer a consumer's settings for review through migrateSettings

## 1.0.0

- Initial release
