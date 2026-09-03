import AdmZip, { IZipEntry } from "adm-zip";
import { basename, dirname, extname } from "node:path";
import * as vscode from "vscode";
import { zipScheme } from "./extension";
import { ZipTree } from "./tree";
import { zipDocumentReloaders } from "./zipDocument";
import { getZipFileExtensions } from "./zipFileExtensions";

function getActiveEditorUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as
    | { uri?: vscode.Uri }
    | undefined;
  return input?.uri;
}

function commonDirPath(uris: vscode.Uri[]): string {
  if (uris.length === 0) return "";

  let commonRoot = dirname(uris[0].path);
  for (let i = 1; i < uris.length; i++) {
    const uri = uris[i];

    while (!uri.path.startsWith(commonRoot)) {
      commonRoot = dirname(commonRoot);
    }
  }

  return commonRoot;
}

function removeExtension(path: string): string {
  return path.substring(0, path.length - extname(path).length);
}

export function getDisplayPath(uri: vscode.Uri): string {
  return uri.scheme === "file" ? uri.fsPath : uri.path;
}

function withNormalizedDisplayPath(uri: vscode.Uri, path: string): vscode.Uri {
  const normalizedPath =
    uri.scheme === "file" && process.platform === "win32"
      ? path.replaceAll("\\", "/")
      : path;

  return uri.with({ path: normalizedPath });
}

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

function openInZipView(uri: vscode.Uri) {
  return vscode.commands.executeCommand("zip.open", uri);
}

export async function zip(_: unknown, dirUrls: vscode.Uri[] | undefined) {
  if (!dirUrls?.[0]) {
    const activeUri = getActiveEditorUri();
    if (activeUri) dirUrls = [activeUri];
  }

  if (!dirUrls?.[0]) return;

  const commonDir = commonDirPath(dirUrls);
  let zipUri =
    dirUrls.length === 1
      ? dirUrls[0].with({ path: removeExtension(dirUrls[0].path) + ".zip" })
      : vscode.Uri.joinPath(
          dirUrls[0].with({ path: commonDir }),
          basename(commonDir) + ".zip",
        );

  const input = vscode.window.createInputBox();
  const baseTitle = "Enter the path for the ZIP file";
  input.title = baseTitle;
  input.value = getDisplayPath(zipUri);
  input.valueSelection = [input.value.length, input.value.length];

  const topLevelName =
    dirUrls.length === 1 && (await isDirectory(dirUrls[0]))
      ? basename(dirUrls[0].path)
      : undefined;
  let topLevelButton =
    topLevelName === undefined
      ? undefined
      : ({
          iconPath: new vscode.ThemeIcon("root-folder-opened"),
          tooltip: `Omit top-level folder (${topLevelName}) from path`,
          location: vscode.QuickInputButtonLocation.Inline,
          toggle: { checked: false },
        } satisfies vscode.QuickInputButton);

  const storeOnlyButton = {
    iconPath: new vscode.ThemeIcon("zap"),
    tooltip: "Store only",
    location: vscode.QuickInputButtonLocation.Inline,
    toggle: { checked: false },
  } satisfies vscode.QuickInputButton;

  const buttons = [];
  if (topLevelButton) buttons.push(topLevelButton);
  buttons.push(storeOnlyButton);
  input.buttons = buttons;

  input.onDidAccept(async () => {
    input.hide();

    const zipPath = input.value.trim();
    if (!zipPath) return;
    zipUri = withNormalizedDisplayPath(zipUri, zipPath);

    const storeOnly = storeOnlyButton.toggle.checked;
    const basePath = topLevelButton?.toggle.checked
      ? dirUrls[0].path
      : commonDir;

    const processEntry = (entry: IZipEntry) => {
      if (storeOnly) {
        entry.header.method = 0;
      }
    };

    const zip = new AdmZip();
    let searchQueue: vscode.Uri[] = [];

    for (const url of dirUrls) {
      try {
        if (
          (await vscode.workspace.fs.stat(url))?.type ===
          vscode.FileType.Directory
        ) {
          searchQueue.push(url);
          continue;
        }
      } catch {}

      const path = url.path.substring(basePath.length);
      processEntry(
        zip.addFile(path, Buffer.from(await vscode.workspace.fs.readFile(url))),
      );
    }

    while (searchQueue.length > 0) {
      const dirUri = searchQueue.pop()!;

      const path = dirUri.path.substring(basePath.length);
      if (path !== "") processEntry(zip.addFile(path + "/", Buffer.from([])));

      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      for (const [name, type] of entries) {
        const childUri = vscode.Uri.joinPath(dirUri, name);
        const path = childUri.path.substring(basePath.length);

        if (type === vscode.FileType.Directory) {
          processEntry(zip.addFile(path + "/", Buffer.from([])));
          searchQueue.push(childUri);
          continue;
        }

        processEntry(
          zip.addFile(
            path,
            Buffer.from(await vscode.workspace.fs.readFile(childUri)),
          ),
        );
      }
    }

    const total = zip.getEntries().length;
    let finished = 0;

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Creating zip file...",
        cancellable: false,
      },
      (progress) =>
        new Promise<void>((resolve, reject) =>
          zip.toBuffer(
            async (buffer) => {
              await vscode.workspace.fs.writeFile(zipUri, buffer);
              resolve();

              const choice = await vscode.window.showInformationMessage(
                "Zip file created successfully: " + getDisplayPath(zipUri),
                "Open",
              );

              if (choice === "Open") {
                const reloadExisting = zipDocumentReloaders.get(
                  zipUri.toString(),
                );
                await openInZipView(zipUri);
                await reloadExisting?.();
              }
            },
            (error) => {
              reject();
              vscode.window.showErrorMessage(
                "Failed to create zip file: " + error,
              );
            },
            undefined,
            () =>
              progress.report({
                increment: (1 / total) * 100,
                message: `Processed ${++finished} of ${total} entries`,
              }),
          ),
        ),
    );
  });

  input.show();
}

export async function selectAndZip(folders: boolean) {
  const selectedUris = await vscode.window.showOpenDialog({
    canSelectFiles: !folders,
    canSelectFolders: folders,
    canSelectMany: true,
    title: `Select ${folders ? "folders" : "files"} to zip`,
    openLabel: "Zip Selected",
  });

  if (!selectedUris?.[0]) return;
  await zip(undefined, selectedUris);
}

const enum OverwriteMode {
  None,
  OverwriteAll,
  SkipAll,
}

export async function unzip(uri: vscode.Uri | undefined) {
  uri ??= getActiveEditorUri();
  if (!uri) return;

  const zip = new AdmZip(Buffer.from(await vscode.workspace.fs.readFile(uri)));

  await extractEntries(
    zip.getEntries(),
    "",
    uri.with({ path: removeExtension(uri.path) }),
    basename(uri.path),
  );
}

// Extracts a single entry of a zip file the same way the whole zip file is extracted
export async function unzipEntry(
  zipUri: vscode.Uri,
  zip: AdmZip,
  entryPath: string,
  isDirectory: boolean,
) {
  const entries = zip
    .getEntries()
    .filter((entry) =>
      isDirectory
        ? entry.entryName.startsWith(entryPath)
        : entry.entryName === entryPath,
    );

  const containingUri = vscode.Uri.joinPath(zipUri, "..");
  const entryName = basename(entryPath.replace(/\/$/, ""));

  await extractEntries(
    entries,
    // Files are extracted into the target directory, folders as the target directory
    isDirectory ? entryPath : entryPath.replace(/[^/]*$/, ""),
    isDirectory ? vscode.Uri.joinPath(containingUri, entryName) : containingUri,
    entryName,
  );
}

function truncateMiddle(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;

  const half = Math.floor((maxLength - 1) / 2);
  return `${name.substring(0, half)}\u2026${name.substring(name.length - half)}`;
}

const browseTitle = (name: string) => `Select the directory to unzip '${name}'`;
const inputTitle = (name: string) => `Enter the path to unzip '${name}'`;

// Both titles truncate the name the same way so neither wraps to a second row
const maxSourceNameLength = 36;

const closeButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("close"),
  tooltip: "Cancel",
};

function inputTargetDirectory(
  defaultTargetUri: vscode.Uri,
  sourceName: string,
  toggleButton?: vscode.QuickInputButton,
): Promise<{ uri: vscode.Uri; browse?: boolean } | undefined> {
  return new Promise((resolve) => {
    const browseButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("folder-opened"),
      tooltip: "Browse for the folder instead",
    };

    const input = vscode.window.createInputBox();
    input.title = inputTitle(truncateMiddle(sourceName, maxSourceNameLength));
    input.value = getDisplayPath(defaultTargetUri);
    input.valueSelection = [input.value.length, input.value.length];
    input.buttons = toggleButton
      ? [toggleButton, browseButton, closeButton]
      : [browseButton, closeButton];

    const targetUri = () => {
      const targetPath = input.value.trim();
      return targetPath
        ? withNormalizedDisplayPath(defaultTargetUri, targetPath)
        : undefined;
    };

    input.onDidAccept(() => {
      const uri = targetUri();
      resolve(uri ? { uri } : undefined);
      input.hide();
    });

    input.onDidTriggerButton((button) => {
      if (button === closeButton) {
        input.hide();
        return;
      }

      if (button !== browseButton) return;

      resolve({ uri: targetUri() ?? defaultTargetUri, browse: true });
      input.hide();
    });

    input.onDidHide(() => {
      resolve(undefined);
      input.dispose();
    });

    input.show();
  });
}

async function browseTargetDirectory(
  defaultTargetUri: vscode.Uri,
  sourceName: string,
  toggleButton?: vscode.QuickInputButton,
): Promise<{ uri: vscode.Uri; edit?: boolean } | undefined> {
  const editButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("edit"),
    tooltip: "Enter the path instead",
  };

  // Browsing starts at the nearest directory that exists
  let startUri = defaultTargetUri;

  while (!(await isDirectory(startUri))) {
    const parentUri = vscode.Uri.joinPath(startUri, "..");
    if (parentUri.path === startUri.path) break;

    startUri = parentUri;
  }

  const picked = await new Promise<
    { uri: vscode.Uri; edit?: boolean } | undefined
  >((resolve) => {
    const picker = vscode.window.createQuickPick<
      vscode.QuickPickItem & { uri: vscode.Uri; browse?: boolean }
    >();
    picker.title = browseTitle(truncateMiddle(sourceName, maxSourceNameLength));
    picker.buttons = toggleButton
      ? [toggleButton, editButton, closeButton]
      : [editButton, closeButton];

    let currentUri = startUri;

    const showDirectory = async (uri: vscode.Uri) => {
      currentUri = uri;
      picker.placeholder = getDisplayPath(uri);
      picker.value = "";
      picker.busy = true;

      let children: [string, vscode.FileType][] = [];

      try {
        children = await vscode.workspace.fs.readDirectory(uri);
      } catch {
        // Directories that cannot be read are shown as empty
      }

      const parentUri = vscode.Uri.joinPath(uri, "..");
      const extractItem = {
        label: `$(check) Unzip to`,
        description: `${getDisplayPath(uri)}`,
        alwaysShow: true,
        uri,
      };

      picker.items = [
        ...(parentUri.path === uri.path
          ? []
          : [{ label: "$(arrow-up) ..", uri: parentUri, browse: true }]),
        extractItem,
        ...children
          .filter(([, type]) => type === vscode.FileType.Directory)
          .map(([name]) => name)
          .sort((nameA, nameB) => nameA.localeCompare(nameB))
          .map((name) => ({
            label: `$(folder) ${name}`,
            uri: vscode.Uri.joinPath(uri, name),
            browse: true,
          })),
      ];

      picker.activeItems = [extractItem];
      picker.busy = false;
    };

    picker.onDidAccept(() => {
      const item = picker.selectedItems[0];
      if (!item) return;

      if (item.browse) {
        showDirectory(item.uri);
        return;
      }

      resolve({ uri: item.uri });
      picker.hide();
    });

    picker.onDidTriggerButton((button) => {
      if (button === closeButton) {
        picker.hide();
        return;
      }

      if (button !== editButton) return;

      resolve({
        uri: currentUri.path === startUri.path ? defaultTargetUri : currentUri,
        edit: true,
      });
      picker.hide();
    });

    picker.onDidHide(() => {
      resolve(undefined);
      picker.dispose();
    });

    picker.show();
    showDirectory(startUri);
  });

  return picked;
}

// The two prompts switch to each other until a target directory is picked
async function pickTargetDirectory(
  defaultTargetUri: vscode.Uri,
  sourceName: string,
  toggleButton?: vscode.QuickInputButton,
): Promise<vscode.Uri | undefined> {
  let promptUri = defaultTargetUri;

  for (;;) {
    const browsed = await browseTargetDirectory(
      promptUri,
      sourceName,
      toggleButton,
    );
    if (!browsed) return undefined;
    if (!browsed.edit) return browsed.uri;

    const typed = await inputTargetDirectory(
      browsed.uri,
      sourceName,
      toggleButton,
    );
    if (!typed) return undefined;
    if (!typed.browse) return typed.uri;

    promptUri = typed.uri;
  }
}

async function extractEntries(
  entries: IZipEntry[],
  prefix: string,
  defaultTargetUri: vscode.Uri,
  sourceName: string,
) {
  const relativeName = (entry: IZipEntry) =>
    entry.entryName.substring(prefix.length);
  const topLevelEntries = entries.filter((entry) => {
    const name = relativeName(entry).replace(/\/$/, "");
    return name !== "" && !name.includes("/");
  });
  const topLevelName =
    topLevelEntries.length === 1 && topLevelEntries[0].entryName.endsWith("/")
      ? topLevelEntries[0].name
      : undefined;

  const topLevelButton =
    topLevelName === undefined
      ? undefined
      : ({
          iconPath: new vscode.ThemeIcon("root-folder-opened"),
          tooltip: `Omit top-level folder (${topLevelName}) from path`,
          location: vscode.QuickInputButtonLocation.Inline,
          toggle: { checked: topLevelName === basename(defaultTargetUri.path) },
        } satisfies vscode.QuickInputButton);

  const targetUri = await pickTargetDirectory(
    defaultTargetUri,
    sourceName,
    topLevelButton,
  );
  if (!targetUri) return;

  const removeTopLevel = topLevelButton?.toggle.checked ?? false;

  const total = entries.length;
  let finished = 0;

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Extracting zip file...",
      cancellable: false,
    },
    (progress) => {
      let resolve!: () => void;
      let reject!: (reason?: unknown) => void;

      const progressEndPromise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });

      (async () => {
        try {
          let overrideMode = OverwriteMode.None;

          for (const entry of entries) {
            const name = relativeName(entry);
            const targetEntryUri = vscode.Uri.joinPath(
              targetUri,
              removeTopLevel ? name.split("/").slice(1).join("/") : name,
            );

            if (entry.isDirectory) {
              await vscode.workspace.fs.createDirectory(targetEntryUri);
            } else {
              let skip = false;

              if (overrideMode !== OverwriteMode.OverwriteAll) {
                let exists = false;

                try {
                  await vscode.workspace.fs.stat(targetEntryUri);
                  exists = true;
                } catch {}

                if (exists && overrideMode !== OverwriteMode.SkipAll) {
                  const choice = await vscode.window.showWarningMessage(
                    `File already exists: ${getDisplayPath(targetEntryUri)}`,
                    { modal: true },
                    "Overwrite",
                    "Overwrite All",
                    "Skip",
                    "Skip All",
                  );

                  if (choice === undefined)
                    throw new Error("Operation cancelled");

                  if (choice === "Overwrite All")
                    overrideMode = OverwriteMode.OverwriteAll;
                  if (choice === "Skip All")
                    overrideMode = OverwriteMode.SkipAll;

                  if (choice === "Skip" || choice === "Skip All") skip = true;
                }
              }

              if (!skip) {
                await vscode.workspace.fs.writeFile(
                  targetEntryUri,
                  entry.getData(),
                );
              }
            }

            progress.report({
              increment: (1 / total) * 100,
              message: `Processed ${++finished} of ${total} entries`,
            });
          }

          resolve();
          vscode.window.showInformationMessage(
            "Zip file extracted successfully to: " + getDisplayPath(targetUri),
          );
        } catch (error) {
          reject();
          vscode.window.showErrorMessage(
            "Failed to extract zip file: " + error,
          );
        }
      })();

      return progressEndPromise;
    },
  );
}

export async function selectAndUnzip() {
  const selectedUri = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Unzip...",
    filters: {
      "Zip files": getZipFileExtensions().map((extension) =>
        extension.substring(1),
      ),
    },
  });

  if (!selectedUri?.[0]) return;
  await unzip(selectedUri?.[0]);
}

export async function selectAndOpen() {
  const selectedUri = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Open",
    title: "Select a zip or zip-based file to open",
  });

  if (!selectedUri?.[0]) return;
  await openInZipView(selectedUri[0]);
}

export async function openContainingZip(
  treeProvider: ZipTree,
  uri: vscode.Uri | undefined,
) {
  uri ??= getActiveEditorUri();
  if (uri?.scheme !== zipScheme) return;
  const zipUri = vscode.Uri.parse(decodeURIComponent(uri.authority));
  await treeProvider.open(zipUri, uri);
}
