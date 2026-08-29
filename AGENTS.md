# AGENTS.md

## Deviations from the shared plugin architecture (G51)

- **`src/rename-delete-handler-component.ts` is a copy of the same file in `obsidian-dev-utils`, not an import.** This plugin owns the rename/delete implementation; the library keeps its copy only until the five plugins that still import it have shipped versions that do not, at which point ODU's copy is deleted. Until then the two files exist side by side and a fix has to be applied to whichever one is still live. The copy differs from ODU's deliberately: the registry registration, the multi-plugin settings merge and the `shouldInvokeHandler` election are all removed, because there is exactly one contributor here.
- **English-only, with no `i18next`.** The copied handler's translation calls became plain template literals. A plugin that later needs translations reinstates `t` from `obsidian-dev-utils/obsidian/i18n/i18n` AND an `src/i18n/i18next.d.ts` augmenting `CustomTypeOptions` — ODU's `t` alone does not type-check the selector form, because the augmentation lives in ODU's compilation rather than its published types.
- **`semver` is a direct dependency**, used at runtime by `src/conflicting-plugins.ts` to compare an installed plugin's manifest version against the first version that no longer conflicts. Same use as in `obsidian-custom-attachment-location`.
