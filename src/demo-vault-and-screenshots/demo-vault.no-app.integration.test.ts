import { registerDemoVaultCoverageSuite } from '@mnaoumov/obsidian-dev-toolkit/demo-vault-coverage';
import { getRootFolder } from '@mnaoumov/typescript-dev-toolkit/root';
import process from 'node:process';

// Keeps the in-repo `demo-vault/` in sync with the plugin's public surface WITHOUT
// launching Obsidian: it reflects the real config from source and asserts every
// setting is documented in a note, and that the guard note/member still exist
// (rename drift). This plugin exposes no public API interface — it owns rename and
// delete handling for the vault and is configured entirely through its settings — so
// only the PluginSettings config class is reflected.
registerDemoVaultCoverageSuite({
  configInterfaces: [{ interfaceName: 'PluginSettings', sourcePath: 'src/settings/plugin-settings.ts' }],
  interfaces: [],
  nonTrivialGuard: {
    expectDemoNote: '01 Renaming a note.md',
    expectMember: 'shouldHandleRenames',
    interfaceName: 'PluginSettings',
    sourcePath: 'src/settings/plugin-settings.ts'
  },
  rootFolder: getRootFolder() ?? process.cwd()
});
