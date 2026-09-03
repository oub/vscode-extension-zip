import * as vscode from "vscode";

const configurationSection = "zip.fileExtensions";

export function getZipFileExtensions(): string[] {
  return vscode.workspace
    .getConfiguration()
    .get<string[]>(configurationSection, [])
    .map((extension) => "." + extension.replace(/^\./, "").toLowerCase())
    .filter((extension) => extension !== ".");
}

export function activateZipFileExtensions(): vscode.Disposable[] {
  // Exposed as a context key so menu "when" clauses can match the configured extensions
  const updateContext = () =>
    vscode.commands.executeCommand(
      "setContext",
      configurationSection,
      getZipFileExtensions(),
    );

  updateContext();

  return [
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(configurationSection)) updateContext();
    }),
  ];
}
