# CHANGELOG

## 2.1.0

- feat(settings): *Treat as attachment extensions* accepts `property:name` and `property:name=value` entries, matched against a note's frontmatter, so an Excalidraw drawing saved as a plain `.md` is an attachment by its `excalidraw-plugin` property (Custom Attachment Location #90). The default is now `.excalidraw.md` plus `property:excalidraw-plugin`. **A list you already have saved is not changed:** to get the new behaviour, add `property:excalidraw-plugin` on its own line in the settings tab. A property entry matches a file only once Obsidian has indexed it.
- fix(conflicts): stop warning about *Delete empty folders* on Consistent Attachments and Links 4.1.0, which no longer offers that command.
- chore(deps): obsidian-dev-utils 107.1.0 and obsidian-integration-testing 17.

## 2.0.0

- **Breaking:** every behaviour is now off by default, including handling renames and renaming the attachment folder. Installing the plugin no longer changes how a vault behaves. A setting already saved keeps its value, but a behaviour you relied on as a 1.x default without ever saving it is now off: turn it back on in the settings tab. A one-time notice on first load says so.
- **Breaking:** when a conflicting plugin version is installed, this plugin stays enabled but inert and explains why in its settings tab, instead of disabling itself. It resumes as soon as the conflict is gone, with no restart.
- **Breaking (API):** the `api` getter on the plugin instance is removed. The API is published only through the plugin API registry, and its types are declared in the root `api.d.ts`.
- feat: the settings tab lists the plugins that depend on this one.
- feat: warn when Consistent Attachments and Links 4.x also offers the Delete empty folders command.
- fix(ui): tell same-named notes apart on the rescue dialog's buttons (#1).
- fix(rename): a canvas whose text node embeds an attachment no longer holds the operation queue forever when moved.
- fix(rename): link updates in canvases are applied without the *Update links* prompt while rename handling is on.
- perf(rename): renaming a folder of notes no longer walks the whole vault twice per renamed file.
- perf(delete): folder deletion answers its backlink checks from an index instead of walking the vault.
- fix(screenshots): the store screenshots no longer show a toast or the note title twice.

## 1.3.0

- **Behaviour change:** `rescueAttachmentUsedByMultipleNotesMode` now defaults to `Prompt`. Users who already enabled *Should rescue shared attachments* are asked which note adopts a tied attachment, instead of the rescue silently stalling.
- docs(agents): anchor the replayFolderDeletion reference to a symbol, not a line
- docs(agents): correct the deviation note, and drop the dead field it would have documented
- test(screenshots-desktop-capture): restore the settings-panel store screenshot
- test(canvas-partial-write-guard): drop the Cancel-click workaround and fix the race it hid
- feat: add a manual vault-wide Delete empty folders command
- feat(rescue): keep a designated attachment unit folder whole on delete
- feat(rescue): ask which note adopts a tied attachment, instead of stalling

## 1.2.0

- chore(deps): sweep onto obsidian-dev-utils 98, integration-testing 12 and test-mocks 5
- test(rename-delete): adopt the regression suites the attachment plugin hands over
- test(bulk-delete): port the Consistent Attachments and Links performance suite onto the handler that owns the cost
- test(rename-delete-handler): land the runAsyncLinkUpdate suppression guards
- feat(api): read the handed-over settings back, at contract 1.1.0
- fix(build): wire build:compile to buildCompile and drop the duplicate leaf script

## 1.1.1

- chore(deps): sweep caret-ranged dependencies to latest
- fix(deps): move to obsidian-integration-testing 11 and obsidian-dev-utils 96.5.2
- fix(deps): drop the brace-expansion file: override that breaks a clean install

## 1.1.0

- feat(api): offer a consumer's settings for review through migrateSettings

## 1.0.0

- Initial release
