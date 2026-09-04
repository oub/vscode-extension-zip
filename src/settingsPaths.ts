/*
Copyright (C) 2026 Brandon Fowler

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Shared by the extension and the uninstall script, so it must not use the VS Code API
import { join } from "node:path";

export const zipEditorViewType = "zip.redirectToTree";
export const editorAssociationsSection = "workbench.editorAssociations";

// Records which settings files were modified, since the uninstall script cannot resolve them itself
export function settingsPathsFile(extensionPath: string): string {
  return join(extensionPath, "settings-paths.json");
}
