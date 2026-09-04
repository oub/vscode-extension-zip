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

// Runs as a plain Node script on uninstall ("vscode:uninstall"), so the VS Code API is unavailable
import { applyEdits, modify, parse } from "jsonc-parser";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  editorAssociationsSection,
  settingsPathsFile,
  zipEditorViewType,
} from "./settingsPaths";

function removeEditorAssociations(settingsPath: string): void {
  const content = readFileSync(settingsPath, "utf8");
  const associations = (
    parse(content) as Record<string, unknown> | undefined
  )?.[editorAssociationsSection] as Record<string, string> | undefined;
  if (!associations) return;

  const remaining = Object.entries(associations).filter(
    ([, viewType]) => viewType !== zipEditorViewType,
  );
  if (remaining.length === Object.keys(associations).length) return;

  const edits = modify(
    content,
    [editorAssociationsSection],
    remaining.length ? Object.fromEntries(remaining) : undefined,
    { formattingOptions: { tabSize: 2, insertSpaces: true } },
  );

  writeFileSync(settingsPath, applyEdits(content, edits), "utf8");
}

let settingsPaths: string[] = [];
try {
  settingsPaths = JSON.parse(
    readFileSync(settingsPathsFile(join(__dirname, "..")), "utf8"),
  );
} catch {
  // Nothing was ever written to a settings file
}

for (const settingsPath of settingsPaths) {
  try {
    removeEditorAssociations(settingsPath);
  } catch {
    // The profile may have been deleted, or its settings may not be readable
  }
}
