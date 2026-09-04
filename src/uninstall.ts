

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
