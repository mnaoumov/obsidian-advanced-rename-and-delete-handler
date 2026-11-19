import { defineEslintConfigs } from '@mnaoumov/obsidian-dev-toolkit/linters/eslint-config';
import { defineConfig } from 'eslint/config';

export const configs = defineEslintConfigs({
  customConfigs() {
    return defineConfig([
      {
        files: ['src/**/*.integration.test.ts', 'src/**/*.integration-helper.ts'],
        rules: {
          /**
           * An integration suite's `evalInObsidian` closures run inside the Obsidian renderer, where
           * `window` and `document` always exist. The rule reads the file's Node test environment,
           * which declares neither, so it reports every `window.x?.` in those closures although none
           * of them can throw.
           */
          'unicorn/no-optional-chaining-on-undeclared-variable': 'off'
        }
      }
    ]);
  },
  editContext(context) {
    // The published contract sits at the repo root beside `api.d.ts`, so a consumer can copy it; lint it as source.
    context.sourceFiles.push('api-contract.ts');
  }
});
