# CHANGELOG

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
- test(bulk-delete): port OCAAL's performance suite onto the handler that owns the cost
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
