import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import {
  editorAssociationsSection,
  settingsPathsFile,
  zipEditorViewType,
} from "./settingsPaths";

const configurationSection = "zip.fileExtensions";

export function getZipFileExtensions(): string[] {
  return vscode.workspace
    .getConfiguration()
    .get<string[]>(configurationSection, [])
    .map((extension) => "." + extension.replace(/^\./, "").toLowerCase())
    .filter((extension) => extension !== ".");
}

// The uninstall script has no VS Code API, so it is told which settings files to clean up
async function rememberSettingsPath(
  context: vscode.ExtensionContext,
): Promise<void> {
  // "<user data>/User[/profiles/<id>]/globalStorage/<extension id>" sits next to "settings.json"
  const settingsPath = join(
    dirname(dirname(context.globalStorageUri.fsPath)),
    "settings.json",
  );
  const file = settingsPathsFile(context.extensionPath);

  let paths: string[] = [];
  try {
    paths = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // The file does not exist yet
  }

  if (paths.includes(settingsPath)) return;
  await writeFile(file, JSON.stringify([...paths, settingsPath]), "utf8");
}

// Clicking a file only opens the Zip view if its extension is associated with the redirect editor
async function updateEditorAssociations(
  context: vscode.ExtensionContext,
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration();
  const current =
    configuration.inspect<Record<string, string>>(editorAssociationsSection)
      ?.globalValue ?? {};

  const updated: Record<string, string> = {};
  for (const [pattern, viewType] of Object.entries(current))
    if (viewType !== zipEditorViewType) updated[pattern] = viewType;

  for (const extension of getZipFileExtensions())
    updated["*" + extension] = zipEditorViewType;

  const patterns = Object.keys(updated);
  const isUnchanged =
    patterns.length === Object.keys(current).length &&
    patterns.every((pattern) => current[pattern] === updated[pattern]);
  if (isUnchanged) return;

  await rememberSettingsPath(context);

  await configuration.update(
    editorAssociationsSection,
    patterns.length ? updated : undefined,
    vscode.ConfigurationTarget.Global,
  );
}

export function activateZipFileExtensions(
  context: vscode.ExtensionContext,
): vscode.Disposable[] {
  const update = () => {
    // Exposed as a context key so menu "when" clauses can match the configured extensions
    vscode.commands.executeCommand(
      "setContext",
      configurationSection,
      getZipFileExtensions(),
    );

    void updateEditorAssociations(context);
  };

  update();

  return [
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(configurationSection)) update();
    }),
  ];
}
