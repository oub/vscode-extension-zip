import AdmZip, { IZipEntry } from "adm-zip";
import { basename, dirname, extname } from "node:path";
import * as vscode from "vscode";
import { extensionUri, zipScheme } from "./extension";
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

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

// Asks the user to confirm overwriting an existing file. Returns false if the
// user declined, in which case the caller should let the user pick another path.
async function confirmOverwrite(uri: vscode.Uri): Promise<boolean> {
  if (!(await fileExists(uri))) return true;

  const choice = await vscode.window.showWarningMessage(
    `A file already exists at "${getDisplayPath(uri)}". Overwrite it?`,
    { modal: true },
    "Overwrite",
  );

  return choice === "Overwrite";
}

function openInZipView(uri: vscode.Uri) {
  return vscode.commands.executeCommand("zip.open", uri);
}

// Step A: a native folder picker, opened at the folder that currently
// contains the (proposed) Zip file.
async function pickZipFolder(
  defaultFolderUri: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  // Browsing starts at the nearest directory that exists
  let startUri = defaultFolderUri;
  while (!(await isDirectory(startUri))) {
    const parentUri = vscode.Uri.joinPath(startUri, "..");
    if (parentUri.path === startUri.path) break;
    startUri = parentUri;
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: startUri,
    title: "Select where to store the Zip file",
    openLabel: "Select Folder",
  });

  return selected?.[0];
}

type ZipNameStepResult =
  | { action: "cancel" }
  | {
      action: "back";
      fileName: string;
      useCompression: boolean;
    }
  | {
      action: "confirmed";
      zipUri: vscode.Uri;
      useCompression: boolean;
    };

// Step B: an inputbox for the file name, with a reminder of the folder
// selected in step A and a back button to return to the folder picker.
function showZipNameInputBox(
  folderUri: vscode.Uri,
  defaultFileName: string,
  defaultUseCompression: boolean,
): Promise<ZipNameStepResult> {
  return new Promise((resolve) => {
    const input = vscode.window.createInputBox();
    input.title = "Enter the Zip file name";
    input.prompt = `Will be saved in: ${getDisplayPath(folderUri)}`;
    input.value = defaultFileName;
    input.valueSelection = [input.value.length, input.value.length];
    // Keep the input open while the modal overwrite-confirmation dialog has focus
    input.ignoreFocusOut = true;

    const compressionButton = {
      iconPath: {
        light: vscode.Uri.joinPath(extensionUri, "media", "compress-light.svg"),
        dark: vscode.Uri.joinPath(extensionUri, "media", "compress-dark.svg"),
      },
      tooltip: "Compress Zip",
      location: vscode.QuickInputButtonLocation.Inline,
      toggle: { checked: defaultUseCompression },
    } satisfies vscode.QuickInputButton;

    input.buttons = [vscode.QuickInputButtons.Back, compressionButton];

    let settled = false;
    const finish = (result: ZipNameStepResult) => {
      if (settled) return;
      settled = true;
      input.dispose();
      resolve(result);
    };

    input.onDidTriggerButton((button) => {
      if (button !== vscode.QuickInputButtons.Back) return;
      finish({
        action: "back",
        fileName: input.value.trim() || defaultFileName,
        useCompression: compressionButton.toggle.checked,
      });
    });

    input.onDidHide(() => finish({ action: "cancel" }));

    input.onDidAccept(async () => {
      const fileName = input.value.trim();
      if (!fileName) return;
      const normalizedFileName =
        folderUri.scheme === "file" && process.platform === "win32"
          ? fileName.replaceAll("\\", "/")
          : fileName;
      const candidateUri = vscode.Uri.joinPath(folderUri, normalizedFileName);

      // Disable the input while the (potentially modal) confirmation is shown,
      // then keep the input box open so the user can pick another name if they decline.
      input.enabled = false;
      const overwriteConfirmed = await confirmOverwrite(candidateUri);
      input.enabled = true;

      if (!overwriteConfirmed) {
        // Bring the input box back to the foreground and reselect the name so
        // the user can easily amend it.
        input.valueSelection = [0, input.value.length];
        input.show();
        return;
      }

      finish({
        action: "confirmed",
        zipUri: candidateUri,
        useCompression: compressionButton.toggle.checked,
      });
    });

    input.show();
  });
}

// Whether to remove the single top-level folder when zipping just one directory;
// kept as a hidden user setting rather than an in-flow toggle.
function shouldRemoveTopLevelFolder(): boolean {
  return (
    vscode.workspace
      .getConfiguration("zip")
      .get<"no" | "yes">("actions.zip.removeTopLevelFolder", "no") === "yes"
  );
}

export async function zip(_: unknown, dirUrls: vscode.Uri[] | undefined) {
  if (!dirUrls?.[0]) {
    const activeUri = getActiveEditorUri();
    if (activeUri) dirUrls = [activeUri];
  }

  if (!dirUrls?.[0]) return;

  const commonDir = commonDirPath(dirUrls);
  const defaultZipUri =
    dirUrls.length === 1
      ? dirUrls[0].with({ path: removeExtension(dirUrls[0].path) + ".zip" })
      : vscode.Uri.joinPath(
          dirUrls[0].with({ path: commonDir }),
          basename(commonDir) + ".zip",
        );

  const topLevelName =
    dirUrls.length === 1 && (await isDirectory(dirUrls[0]))
      ? basename(dirUrls[0].path)
      : undefined;

  let folderUri = vscode.Uri.joinPath(defaultZipUri, "..");
  let fileName = basename(defaultZipUri.path);
  let useCompression = true;
  let zipUri: vscode.Uri;

  for (;;) {
    const selectedFolder = await pickZipFolder(folderUri);
    if (!selectedFolder) return;
    folderUri = selectedFolder;

    const result = await showZipNameInputBox(
      folderUri,
      fileName,
      useCompression,
    );

    if (result.action === "cancel") return;

    useCompression = result.useCompression;

    if (result.action === "back") {
      fileName = result.fileName;
      continue;
    }

    zipUri = result.zipUri;
    break;
  }

  // Only a single selected directory can have its own top-level name excluded;
  // single files and multi-selections are always relative to their common directory.
  const basePath =
    topLevelName !== undefined && shouldRemoveTopLevelFolder()
      ? dirUrls[0].path
      : commonDir;

  {
    const processEntry = (entry: IZipEntry) => {
      if (!useCompression) {
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
    let reportProgress: ((finished: number, total: number) => void) | undefined;

    const bufferPromise = new Promise<Buffer>((resolve, reject) => {
      zip.toBuffer(
        (buffer) => resolve(buffer),
        (error) => reject(error),
        undefined,
        () => {
          finished++;
          reportProgress?.(finished, total);
        },
      );
    });

    // Avoid the "Creating zip file..." notification flashing in and out for
    // zips that finish almost instantly: only show it once creation has been
    // running for a bit.
    const showProgressDelayMs = 1000;
    const stillRunningAfterDelay = await Promise.race([
      bufferPromise.then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(true), showProgressDelayMs),
      ),
    ]);

    let buffer: Buffer;
    try {
      buffer = stillRunningAfterDelay
        ? await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Creating zip file...",
              cancellable: false,
            },
            (progress) => {
              // Catch up on entries that were already processed during the delay.
              if (finished > 0) {
                progress.report({
                  increment: (finished / total) * 100,
                  message: `Processed ${finished} of ${total} entries`,
                });
              }
              reportProgress = (finished, total) =>
                progress.report({
                  increment: (1 / total) * 100,
                  message: `Processed ${finished} of ${total} entries`,
                });
              return bufferPromise;
            },
          )
        : await bufferPromise;
    } catch (error) {
      vscode.window.showErrorMessage("Failed to create zip file: " + error);
      return;
    }

    await vscode.workspace.fs.writeFile(zipUri, buffer);

    const reloadExisting = zipDocumentReloaders.get(zipUri.toString());
    // Select the file in the Explorer view, then open it in the Zip view,
    // mirroring what clicking the file in the Explorer would do.
    await vscode.commands.executeCommand("revealInExplorer", zipUri);
    await openInZipView(zipUri);
    await reloadExisting?.();

    vscode.window.showInformationMessage("Zip file created successfully.");
  }
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
    removeExtension(basename(uri.path)),
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
    removeExtension(basename(zipUri.path)),
  );
}

function truncateMiddle(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;

  const half = Math.floor((maxLength - 1) / 2);
  return `${name.substring(0, half)}\u2026${name.substring(name.length - half)}`;
}

// Truncated so the dialog title doesn't wrap to a second row
const maxSourceNameLength = 36;

async function pickTargetDirectory(
  defaultTargetUri: vscode.Uri,
  sourceName: string,
): Promise<vscode.Uri | undefined> {
  // Browsing starts at the nearest directory that exists
  let startUri = defaultTargetUri;

  while (!(await isDirectory(startUri))) {
    const parentUri = vscode.Uri.joinPath(startUri, "..");
    if (parentUri.path === startUri.path) break;

    startUri = parentUri;
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: startUri,
    title: `Select the directory to unzip '${truncateMiddle(sourceName, maxSourceNameLength)}'`,
    openLabel: "Unzip Here",
  });

  return selected?.[0];
}

async function extractEntries(
  entries: IZipEntry[],
  prefix: string,
  defaultTargetUri: vscode.Uri,
  sourceName: string,
  archiveBaseName: string,
) {
  const relativeName = (entry: IZipEntry) =>
    entry.entryName.substring(prefix.length);

  const pickedUri = await pickTargetDirectory(defaultTargetUri, sourceName);
  if (!pickedUri) return;

  const useSubfolder =
    vscode.workspace
      .getConfiguration("zip")
      .get<"no" | "yes">("actions.unzip.addFileNameToPath", "no") === "yes";
  const targetUri = useSubfolder
    ? vscode.Uri.joinPath(pickedUri, archiveBaseName)
    : pickedUri;

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
            const targetEntryUri = vscode.Uri.joinPath(targetUri, name);

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
