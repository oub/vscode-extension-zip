
// Shared by the extension and the uninstall script, so it must not use the VS Code API
import { join } from "node:path";

export const zipEditorViewType = "zip.redirectToTree";
export const editorAssociationsSection = "workbench.editorAssociations";

// Records which settings files were modified, since the uninstall script cannot resolve them itself
export function settingsPathsFile(extensionPath: string): string {
  return join(extensionPath, "settings-paths.json");
}
