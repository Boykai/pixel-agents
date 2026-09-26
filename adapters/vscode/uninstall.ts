/**
 * `vscode:uninstall` hook (see package.json scripts) — VS Code executes this
 * with plain Node after the extension has been fully uninstalled. The `vscode`
 * module does not exist here; only Node APIs are available.
 *
 * Hook installs and consent are shared with standalone and other VS Code
 * installations. We have no durable exclusive-ownership evidence, so removing
 * this adapter must not uninstall another adapter's hooks or revoke its consent.
 * Disable each provider's hooks in Settings before uninstalling when removal of
 * the shared installation is intended.
 */
console.log(
  '[Pixel Agents] Shared provider hooks and consent were retained. Disable hooks in Pixel Agents Settings to remove them for all adapters.',
);
