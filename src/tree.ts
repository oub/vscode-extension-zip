import { basename } from "node:path";
import * as vscode from "vscode";
import { getDisplayPath, unzip, unzipEntry } from "./actions";
import { zipEditorViewType, zipScheme, zipViewId } from "./extension";
import { ZipDocument } from "./zipDocument";
import { ZipFileSystem } from "./zipFileSystem";

export interface ZipTreeNode {
  readonly uri: vscode.Uri;
  readonly zipUri: vscode.Uri;
  type: vscode.FileType;
}

// Maps ASCII letters/digits to their Mathematical Sans-Serif Bold Unicode equivalents
function toBoldSansSerif(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.codePointAt(0)!;
      if (code >= 65 && code <= 90)
        return String.fromCodePoint(0x1d5d4 + (code - 65));
      if (code >= 97 && code <= 122)
        return String.fromCodePoint(0x1d5ee + (code - 97));
      if (code >= 48 && code <= 57)
        return String.fromCodePoint(0x1d7ec + (code - 48));
      return char;
    })
    .join("");
}

// Maps ASCII letters to their Mathematical Sans-Serif Italic Unicode equivalents
function toItalicSansSerif(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.codePointAt(0)!;
      if (code >= 65 && code <= 90)
        return String.fromCodePoint(0x1d608 + (code - 65));
      if (code >= 97 && code <= 122)
        return String.fromCodePoint(0x1d622 + (code - 97));
      return char;
    })
    .join("");
}

// zip-file://<url-encoded-zip-file-uri>/<zip-file-path>/<entry-path>
function getEntryUri(zipUri: vscode.Uri, entryPath = ""): vscode.Uri {
  return vscode.Uri.from({
    scheme: zipScheme,
    authority: encodeURIComponent(zipUri.toString()),
    path: entryPath ? `${zipUri.path}/${entryPath}` : zipUri.path,
  });
}

export class ZipTree
  implements
    vscode.TreeDataProvider<ZipTreeNode>,
    vscode.TreeDragAndDropController<ZipTreeNode>
{
  private static readonly openZipsStateKey = "openZips";

  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    ZipTreeNode | undefined
  >();
  private readonly openZips = new Map<
    string,
    {
      document: ZipDocument;
      disposables: vscode.Disposable[];
      pinned: boolean;
      readOnly: boolean;
    }
  >();
  // Tree items are refreshed and revealed by identity, so nodes must be stable
  private readonly nodes = new Map<string, ZipTreeNode>();
  private readonly view: vscode.TreeView<ZipTreeNode>;
  private readonly renameListener = vscode.workspace.onDidRenameFiles((event) =>
    this.handleRenamedZips(event.files),
  );

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  // Identifies the entries of the view itself while they are being dragged
  private readonly nodesMimeType = `application/vnd.code.tree.${zipViewId.toLowerCase()}`;
  readonly dropMimeTypes = ["text/uri-list", this.nodesMimeType];
  readonly dragMimeTypes = ["text/uri-list"];

  constructor(
    private readonly zipFileSystem: ZipFileSystem,
    private readonly state: vscode.Memento,
  ) {
    this.view = vscode.window.createTreeView(zipViewId, {
      treeDataProvider: this,
      dragAndDropController: this,
      showCollapseAll: true,
    });
  }

  private isZipReadOnly(zipUri: vscode.Uri): boolean {
    return !!this.openZips.get(zipUri.toString())?.readOnly;
  }

  setReadOnly(node: ZipTreeNode, readOnly: boolean): void {
    const openZip = this.openZips.get(node.zipUri.toString());
    if (!openZip || openZip.readOnly === readOnly) return;

    openZip.readOnly = readOnly;
    this.zipFileSystem.setReadOnly(node.zipUri, readOnly);
    this.saveOpenZips();

    // Children's context values also depend on the zip file's read-only state
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  handleDrag(
    source: readonly ZipTreeNode[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    const nodes = source.filter(
      (node) => !this.isRoot(node) && !this.isZipReadOnly(node.zipUri),
    );
    if (!nodes.length) return;

    // Dropping these URIs on the editor area opens the entries in new tabs
    const uris = nodes
      .filter((node) => node.type === vscode.FileType.File)
      .map((node) => node.uri.toString());

    if (uris.length)
      dataTransfer.set(
        "text/uri-list",
        new vscode.DataTransferItem(uris.join("\r\n")),
      );
    dataTransfer.set(this.nodesMimeType, new vscode.DataTransferItem(nodes));
  }

  async handleDrop(
    target: ZipTreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    const nodes = dataTransfer.get(this.nodesMimeType)?.value as
      | ZipTreeNode[]
      | undefined;

    if (nodes?.length) {
      if (!target) return;
      if (this.isZipReadOnly(target.zipUri)) {
        vscode.window.showWarningMessage(
          "Cannot modify zip file entries while this zip file is read-only.",
        );
        return;
      }

      const zipKey = target.zipUri.toString();
      const moved = nodes.filter((node) => node.zipUri.toString() === zipKey);
      const copied = nodes.filter((node) => node.zipUri.toString() !== zipKey);

      if (moved.length) await this.moveInZip(target, moved);
      if (copied.length)
        await this.addToZip(
          target,
          copied.map((node) => node.uri),
        );

      return;
    }

    const uriList = await dataTransfer.get("text/uri-list")?.asString();
    if (!uriList) return;

    const uris = uriList
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => vscode.Uri.parse(line));

    // Opening dropped zip files is allowed even in read-only mode
    if (target) {
      if (this.isZipReadOnly(target.zipUri)) {
        vscode.window.showWarningMessage(
          "Cannot add files to zip while this zip file is read-only.",
        );
        return;
      }
      await this.addToZip(target, uris);
      return;
    }

    for (const uri of uris) {
      // Dropped folders are ignored instead of reported as unreadable zip files
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File) continue;
      } catch {
        continue;
      }

      await this.open(uri);
    }
  }

  // The message keeps the empty tree droppable; viewsWelcome content would
  // cover the tree and swallow drops, so it is not used
  private updateMessage(): void {
    // this.view.message = this.openZips.size
    //   ? undefined
    //   : toItalicSansSerif(
    //       "Drag a zip file here to open it, or use the Open Zip File button above.",
    //     );
    this.view.message = undefined;
  }

  private async collectDroppedEntries(uris: vscode.Uri[], prefix: string) {
    const collected: {
      entryName: string;
      uri: vscode.Uri;
      isDirectory: boolean;
    }[] = [];
    const queue = uris.map((uri) => ({ uri, prefix }));

    while (queue.length) {
      const { uri, prefix } = queue.pop()!;
      const isDirectory =
        (await vscode.workspace.fs.stat(uri)).type ===
        vscode.FileType.Directory;
      const entryName = prefix + basename(uri.path) + (isDirectory ? "/" : "");

      collected.push({ entryName, uri, isDirectory });
      if (!isDirectory) continue;

      for (const [childName] of await vscode.workspace.fs.readDirectory(uri)) {
        queue.push({
          uri: vscode.Uri.joinPath(uri, childName),
          prefix: entryName,
        });
      }
    }

    return collected;
  }

  // Dropping on a file targets the folder containing it
  private getDropPrefix(target: ZipTreeNode): string {
    const entryPath = this.getEntryPath(target);
    return target.type === vscode.FileType.Directory
      ? entryPath
      : entryPath.replace(/[^/]*$/, "");
  }

  private async confirmOverwrite(entryNames: string[]): Promise<boolean> {
    if (!entryNames.length) return true;

    const choice = await vscode.window.showWarningMessage(
      entryNames.length === 1
        ? `${entryNames[0]} already exists in the zip file.`
        : `${entryNames.length} files already exist in the zip file.`,
      { modal: true },
      "Overwrite",
    );

    return choice === "Overwrite";
  }

  private async moveInZip(
    target: ZipTreeNode,
    nodes: ZipTreeNode[],
  ): Promise<void> {
    const document = this.openZips.get(target.zipUri.toString())?.document;
    if (!document) return;

    const prefix = this.getDropPrefix(target);
    const moved: {
      entryName: string;
      newName: string;
      isDirectory: boolean;
      data: Buffer;
    }[] = [];

    for (const node of nodes) {
      const entryPath = this.getEntryPath(node);
      const isFolder = node.type === vscode.FileType.Directory;
      const newPath = prefix + basename(entryPath) + (isFolder ? "/" : "");

      // Entries already in place and folders dropped inside themselves stay where they are
      if (newPath === entryPath || (isFolder && prefix.startsWith(entryPath)))
        continue;

      for (const entry of document.zip.getEntries()) {
        // Folders are moved with everything they contain
        if (
          isFolder
            ? !entry.entryName.startsWith(entryPath)
            : entry.entryName !== entryPath
        )
          continue;

        moved.push({
          entryName: entry.entryName,
          newName: newPath + entry.entryName.substring(entryPath.length),
          isDirectory: entry.isDirectory,
          data: entry.isDirectory ? Buffer.from([]) : entry.getData(),
        });
      }
    }

    if (!moved.length) return;

    try {
      const movedNames = new Set(moved.map(({ entryName }) => entryName));
      const conflicts = moved.filter(
        ({ newName, isDirectory }) =>
          !isDirectory &&
          !movedNames.has(newName) &&
          document.zip.getEntry(newName),
      );

      if (
        !(await this.confirmOverwrite(conflicts.map(({ newName }) => newName)))
      )
        return;

      for (const { entryName } of moved) {
        document.zip.deleteFile(entryName, true);
      }

      for (const { newName, isDirectory, data } of moved) {
        const existing = document.zip.getEntry(newName);

        if (!existing) {
          document.zip.addFile(newName, data);
        } else if (!isDirectory) {
          existing.header.time = new Date();
          document.zip.updateFile(existing, data);
        }
      }

      await document.save();
    } catch (error) {
      vscode.window.showErrorMessage("Failed to move in zip file: " + error);
    }
  }

  private async addToZip(
    target: ZipTreeNode,
    uris: vscode.Uri[],
  ): Promise<void> {
    const document = this.openZips.get(target.zipUri.toString())?.document;
    if (!document) return;

    try {
      const collected = await this.collectDroppedEntries(
        uris,
        this.getDropPrefix(target),
      );
      const conflicts = collected.filter(
        ({ entryName, isDirectory }) =>
          !isDirectory && document.zip.getEntry(entryName),
      );

      if (
        !(await this.confirmOverwrite(
          conflicts.map(({ entryName }) => entryName),
        ))
      )
        return;

      for (const { entryName, uri, isDirectory } of collected) {
        const existing = document.zip.getEntry(entryName);

        if (isDirectory) {
          if (!existing) document.zip.addFile(entryName, Buffer.from([]));
          continue;
        }

        const content = Buffer.from(await vscode.workspace.fs.readFile(uri));

        if (existing) {
          existing.header.time = new Date();
          document.zip.updateFile(existing, content);
        } else {
          document.zip.addFile(entryName, content);
        }
      }

      await document.save();
    } catch (error) {
      vscode.window.showErrorMessage("Failed to add to zip file: " + error);
    }
  }

  private getNode(
    zipUri: vscode.Uri,
    uri: vscode.Uri,
    type: vscode.FileType,
  ): ZipTreeNode {
    const key = uri.toString();
    const existing = this.nodes.get(key);

    if (existing) {
      existing.type = type;
      return existing;
    }

    const node: ZipTreeNode = { uri, zipUri, type };
    this.nodes.set(key, node);

    return node;
  }

  private getRootNode(zipUri: vscode.Uri): ZipTreeNode {
    return this.getNode(zipUri, getEntryUri(zipUri), vscode.FileType.Directory);
  }

  private isRoot(node: ZipTreeNode): boolean {
    return node.uri.path === node.zipUri.path;
  }

  private getEntryPath(node: ZipTreeNode): string {
    return node.uri.path.substring(node.zipUri.path.length + 1);
  }

  private getChildUri(node: ZipTreeNode, name: string): vscode.Uri {
    const prefix = node.uri.path.endsWith("/")
      ? node.uri.path
      : node.uri.path + "/";
    return node.uri.with({ path: prefix + name });
  }

  private saveOpenZips(): void {
    this.state.update(
      ZipTree.openZipsStateKey,
      [...this.openZips.values()].map(({ document, pinned, readOnly }) => ({
        uri: document.uri.toString(),
        pinned,
        readOnly,
      })),
    );
  }

  // Reopens the zip files that were in the view when the window was closed
  async restore(): Promise<void> {
    const storedZips = this.state.get<
      { uri: string; pinned: boolean; readOnly?: boolean }[]
    >(ZipTree.openZipsStateKey, []);

    for (const { uri, pinned, readOnly } of storedZips) {
      try {
        await this.addZip(vscode.Uri.parse(uri), pinned, !!readOnly);
      } catch {
        // Zip files that can no longer be read are dropped from the view
      }
    }

    this.saveOpenZips();
    this.updateMessage();
  }

  private watchZip(zipUri: vscode.Uri): vscode.Disposable[] {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(zipUri, "*"),
    );

    return [
      watcher,
      watcher.onDidChange(() => this.reloadZip(zipUri)),
      watcher.onDidCreate(() => this.reloadZip(zipUri)),
      watcher.onDidDelete(() => this.handleDeletedZip(zipUri)),
    ];
  }

  private async reloadZip(zipUri: vscode.Uri): Promise<void> {
    try {
      await this.openZips.get(zipUri.toString())?.document.reloadIfModified();
    } catch {
      // The previous contents are kept when a partially written zip file cannot be read
    }
  }

  private async handleDeletedZip(zipUri: vscode.Uri): Promise<void> {
    try {
      // Writes that replace the file emit a delete followed by a create
      await vscode.workspace.fs.stat(zipUri);
      await this.reloadZip(zipUri);
    } catch {
      this.closeZip(zipUri);
    }
  }

  // Renames done outside of VS Code are seen as a delete instead, which closes the zip file
  private async handleRenamedZips(
    files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[],
  ): Promise<void> {
    const renamed: {
      oldUri: vscode.Uri;
      newUri: vscode.Uri;
      pinned: boolean;
      readOnly: boolean;
    }[] = [];

    for (const { oldUri, newUri } of files) {
      const oldKey = oldUri.toString();

      for (const [key, openZip] of this.openZips) {
        if (key === oldKey) {
          renamed.push({
            oldUri,
            newUri,
            pinned: openZip.pinned,
            readOnly: openZip.readOnly,
          });
        } else if (key.startsWith(oldKey + "/")) {
          // The zip file is inside a renamed folder
          renamed.push({
            oldUri: vscode.Uri.parse(key),
            newUri: vscode.Uri.parse(
              newUri.toString() + key.substring(oldKey.length),
            ),
            pinned: openZip.pinned,
            readOnly: openZip.readOnly,
          });
        }
      }
    }

    for (const { oldUri, newUri, pinned, readOnly } of renamed) {
      this.closeZip(oldUri);

      try {
        await this.addZip(newUri, pinned, readOnly);
      } catch {
        // The renamed zip file is dropped from the view if it can no longer be read
      }
    }
  }

  private closeUnpinnedZips(exceptUri?: vscode.Uri): void {
    const exceptKey = exceptUri?.toString();

    for (const [key, openZip] of this.openZips) {
      if (key !== exceptKey && !openZip.pinned)
        this.closeZip(openZip.document.uri);
    }
  }

  private async addZip(
    zipUri: vscode.Uri,
    pinned = false,
    readOnly = true,
  ): Promise<void> {
    const key = zipUri.toString();
    const openZip = this.openZips.get(key);

    if (openZip) {
      await openZip.document.reload();
      return;
    }

    const document = await ZipDocument.open(zipUri);

    // Only one unpinned zip file is shown at a time
    if (!pinned) this.closeUnpinnedZips();

    this.openZips.set(key, {
      document,
      pinned,
      readOnly,
      disposables: [
        document.onDidChange(() =>
          this.onDidChangeTreeDataEmitter.fire(this.getRootNode(zipUri)),
        ),
        ...this.watchZip(zipUri),
      ],
    });

    this.zipFileSystem.registerZipFile(document);
    this.zipFileSystem.setReadOnly(zipUri, readOnly);
    this.saveOpenZips();
    this.onDidChangeTreeDataEmitter.fire(undefined);
    this.updateMessage();
  }

  setPinned(node: ZipTreeNode, pinned: boolean): void {
    const openZip = this.openZips.get(node.zipUri.toString());
    if (!openZip || openZip.pinned === pinned) return;

    openZip.pinned = pinned;

    // An unpinned zip file becomes the one shown until another one is opened
    if (!pinned) this.closeUnpinnedZips(node.zipUri);

    this.saveOpenZips();
    this.onDidChangeTreeDataEmitter.fire(this.getRootNode(node.zipUri));
  }

  async open(zipUri: vscode.Uri, revealUri?: vscode.Uri): Promise<void> {
    try {
      await this.addZip(zipUri);
    } catch (error) {
      vscode.window.showErrorMessage("Failed to open zip file: " + error);
      return;
    }

    const target = revealUri
      ? this.getNode(
          zipUri,
          revealUri,
          revealUri.path.endsWith("/")
            ? vscode.FileType.Directory
            : vscode.FileType.File,
        )
      : this.getRootNode(zipUri);

    await this.view.reveal(target, {
      expand: true,
      select: !!revealUri,
      focus: false,
    });
  }

  close(node: ZipTreeNode): void {
    this.closeZip(node.zipUri);
  }

  private closeZip(zipUri: vscode.Uri): void {
    const key = zipUri.toString();
    const openZip = this.openZips.get(key);
    if (!openZip) return;

    openZip.disposables.forEach((disposable) => disposable.dispose());
    openZip.document.dispose();
    this.openZips.delete(key);
    this.saveOpenZips();

    for (const [nodeKey, cached] of this.nodes) {
      if (cached.zipUri.toString() === key) this.nodes.delete(nodeKey);
    }

    this.onDidChangeTreeDataEmitter.fire(undefined);
    this.updateMessage();
  }

  async refresh(node?: ZipTreeNode): Promise<void> {
    const openZips = node
      ? [this.openZips.get(node.zipUri.toString())]
      : [...this.openZips.values()];

    await Promise.all(openZips.map((openZip) => openZip?.document.reload()));
  }

  async createFile(node: ZipTreeNode): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: "New file name" });
    if (!name) return;

    await this.zipFileSystem.writeFile(
      this.getChildUri(node, name),
      new Uint8Array(),
      {
        create: true,
        overwrite: false,
      },
    );
  }

  async createFolder(node: ZipTreeNode): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: "New folder name",
    });
    if (!name) return;

    await this.zipFileSystem.createDirectory(
      this.getChildUri(node, name.endsWith("/") ? name : name + "/"),
    );
  }

  async rename(node: ZipTreeNode): Promise<void> {
    const trailingSlash = node.type === vscode.FileType.Directory ? "/" : "";
    const entryPath = this.getEntryPath(node).replace(/\/$/, "");

    const newPath = await vscode.window.showInputBox({
      prompt: "New name",
      value: entryPath,
    });
    if (!newPath || newPath === entryPath) return;

    await this.zipFileSystem.rename(
      node.uri,
      getEntryUri(node.zipUri, newPath.replace(/\/$/, "") + trailingSlash),
      { overwrite: false },
    );
  }

  async delete(node: ZipTreeNode): Promise<void> {
    await this.zipFileSystem.delete(node.uri, { recursive: true });
  }

  async unzip(node: ZipTreeNode): Promise<void> {
    if (this.isRoot(node)) return unzip(node.zipUri);

    const document = this.openZips.get(node.zipUri.toString())?.document;
    if (!document) return;

    await unzipEntry(
      node.zipUri,
      document.zip,
      this.getEntryPath(node),
      node.type === vscode.FileType.Directory,
    );
  }

  // The label already shows the file name, so only its folder is described
  private getZipFolderPath(zipUri: vscode.Uri): string {
    const path = vscode.workspace.asRelativePath(zipUri);
    const folder = path.replace(/[\\/]?[^\\/]*$/, "");

    // Absolute paths keep their separators, workspace-relative ones read better
    return path === getDisplayPath(zipUri)
      ? folder
      : folder.split(/[\\/]/).join(" • ");
  }

  private formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  async getTreeItem(node: ZipTreeNode): Promise<vscode.TreeItem> {
    const isRoot = this.isRoot(node);
    const isDirectory = node.type === vscode.FileType.Directory;

    const item = new vscode.TreeItem(
      node.uri,
      // Folders start expanded so an opened zip file shows its whole contents
      isDirectory
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );

    item.id = node.uri.toString();

    const openZip = this.openZips.get(node.zipUri.toString());
    const readOnlySuffix = openZip?.readOnly ? "ReadOnly" : "Editable";

    item.contextValue = isRoot
      ? `zipRoot${openZip?.pinned ? "Pinned" : "Unpinned"}${readOnlySuffix}`
      : isDirectory
        ? `zipFolder${readOnlySuffix}`
        : `zipFile${readOnlySuffix}`;
    item.tooltip = isRoot
      ? getDisplayPath(node.zipUri)
      : this.getEntryPath(node);

    if (isRoot) {
      const description = [];
      const folderPath = this.getZipFolderPath(node.zipUri);
      if (folderPath !== "") {
        description.push(folderPath);
      }
      const size = this.formatFileSize(
        (await vscode.workspace.fs.stat(node.zipUri)).size,
      );
      description.push(`(${size})`);
      if (openZip?.readOnly) {
        description.push("[Read-only]");
      }
      item.description = description.join(" ");
      item.resourceUri = node.zipUri;
      // ThemeIcon.File forces file-kind icon resolution; otherwise an expandable
      // item always gets the generic folder icon regardless of resourceUri's extension
      item.iconPath = vscode.ThemeIcon.File;
    } else if (!isDirectory) {
      // Add file size as description for files
      const document = openZip?.document;
      if (document) {
        const entryPath = this.getEntryPath(node);
        const entry = document.zip.getEntry(entryPath);
        if (entry && !entry.isDirectory) {
          item.description = `(${this.formatFileSize(entry.header.size)})`;
        }
      }
      item.command = {
        command: "vscode.open",
        title: "Open File in Zip",
        arguments: [node.uri],
      };
    }

    return item;
  }

  getChildren(node?: ZipTreeNode): ZipTreeNode[] {
    if (!node) {
      return [...this.openZips.values()].map(({ document }) =>
        this.getRootNode(document.uri),
      );
    }

    if (node.type !== vscode.FileType.Directory) return [];

    return this.getChildEntries(node)
      .sort(([nameA, typeA], [nameB, typeB]) =>
        typeA === typeB
          ? nameA.localeCompare(nameB)
          : typeA === vscode.FileType.Directory
            ? -1
            : 1,
      )
      .map(([name, type]) =>
        this.getNode(node.zipUri, this.getChildUri(node, name), type),
      );
  }

  private getChildEntries(node: ZipTreeNode): [string, vscode.FileType][] {
    const document = this.openZips.get(node.zipUri.toString())?.document;
    if (!document) return [];

    const prefix = this.getEntryPath(node);
    const children = new Map<string, vscode.FileType>();

    for (const entry of document.zip.getEntries()) {
      if (!entry.entryName.startsWith(prefix)) continue;

      const relativeName = entry.entryName.substring(prefix.length);
      const separator = relativeName.indexOf("/");

      // Directories are not always stored as their own entry
      if (separator !== -1) {
        children.set(
          relativeName.substring(0, separator + 1),
          vscode.FileType.Directory,
        );
      } else if (relativeName) {
        children.set(relativeName, vscode.FileType.File);
      }
    }

    return [...children];
  }

  getParent(node: ZipTreeNode): ZipTreeNode | undefined {
    if (this.isRoot(node)) return undefined;

    const parentPath = node.uri.path.replace(/\/$/, "").replace(/\/[^/]*$/, "");
    if (parentPath === node.zipUri.path) return this.getRootNode(node.zipUri);

    return this.getNode(
      node.zipUri,
      node.uri.with({ path: parentPath + "/" }),
      vscode.FileType.Directory,
    );
  }

  dispose(): void {
    for (const { document, disposables } of this.openZips.values()) {
      disposables.forEach((disposable) => disposable.dispose());
      document.dispose();
    }

    this.openZips.clear();
    this.nodes.clear();
    this.renameListener.dispose();
    this.view.dispose();
  }
}

// Zip files are associated with this editor so that opening one shows the view instead of a tab
export function activateZipEditorRedirect(
  treeProvider: ZipTree,
): vscode.Disposable[] {
  const redirect = async (uri: vscode.Uri) => {
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputCustom &&
          tab.input.viewType === zipEditorViewType &&
          tab.input.uri.toString() === uri.toString(),
      );

    await vscode.window.tabGroups.close(tabs);
    await treeProvider.open(uri);
  };

  const provider: vscode.CustomReadonlyEditorProvider = {
    openCustomDocument: (uri) => ({ uri, dispose: () => {} }),
    resolveCustomEditor: (document) => {
      // Disposing the editor while it is opening fails, so it is closed once it is open
      setTimeout(() => redirect(document.uri), 0);
    },
  };

  return [
    vscode.window.registerCustomEditorProvider(zipEditorViewType, provider),
  ];
}
