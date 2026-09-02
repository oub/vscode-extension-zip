import * as vscode from "vscode";
import { zipEntryScheme } from "./extension";
import { ZipDocument } from "./zipDocument";

export class ZipEntryFileSystem implements vscode.FileSystemProvider {
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  private readonly onDidAddZipDocumentEmitter = new vscode.EventEmitter<
    [string, ZipDocument]
  >();
  private readonly documentMap = new Map<string, ZipDocument>();
  // Zip file URIs (as strings) currently in read-only mode
  private readonly readOnlyZips = new Set<string>();

  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;
  readonly onDidAddZipDocument = this.onDidAddZipDocumentEmitter.event;

  isReadOnly(zipUri: vscode.Uri): boolean {
    return this.readOnlyZips.has(zipUri.toString());
  }

  // Kept in sync with the read-only mode of the zip file's Zip Explorer entry
  setReadOnly(zipUri: vscode.Uri, readOnly: boolean): void {
    const zipUriStr = zipUri.toString();
    if (this.readOnlyZips.has(zipUriStr) === readOnly) return;

    if (readOnly) this.readOnlyZips.add(zipUriStr);
    else this.readOnlyZips.delete(zipUriStr);

    // Editors that are already open only re-stat when their file is reported as changed
    this.onDidChangeFileEmitter.fire(
      vscode.workspace.textDocuments
        .filter(
          (document) =>
            document.uri.scheme === zipEntryScheme &&
            !document.isDirty &&
            this.parseUri(document.uri)[0] === zipUriStr,
        )
        .map((document) => ({
          type: vscode.FileChangeType.Changed,
          uri: document.uri,
        })),
    );
  }

  registerZipFile(document: ZipDocument): void {
    const uriStr = document.uri.toString();

    this.documentMap.set(uriStr, document);
    this.onDidAddZipDocumentEmitter.fire([uriStr, document]);

    document.onDidDispose(() => {
      if (this.documentMap.get(uriStr) === document) {
        this.documentMap.delete(uriStr);
      }
      this.readOnlyZips.delete(uriStr);
    });
  }

  private parseUri(uri: vscode.Uri) {
    const zipUriStr = decodeURIComponent(uri.authority);
    const zipUri = vscode.Uri.parse(zipUriStr);
    const entryPath = uri.path.substring(zipUri.path.length + 1); // +1 to remove the leading slash
    return [zipUriStr, zipUri, entryPath] as const;
  }

  getZipFile(uri: vscode.Uri): ZipDocument | undefined {
    const [zipUriStr] = this.parseUri(uri);
    return this.documentMap.get(zipUriStr);
  }

  private async readUri(uri: vscode.Uri) {
    const [zipUriStr, zipUri, entryPath] = this.parseUri(uri);

    let document = this.documentMap.get(zipUriStr);
    if (!document) {
      try {
        document = await ZipDocument.open(zipUri);
      } catch (e) {
        // Pass
      }
    }

    return [document, entryPath] as const;
  }

  private isRoot(uri: vscode.Uri): boolean {
    const zipUriStr = decodeURIComponent(uri.authority);
    const zipUri = vscode.Uri.parse(zipUriStr);
    return uri.path === zipUri.path;
  }

  private assertWritable(uri: vscode.Uri): void {
    const [zipUriStr] = this.parseUri(uri);
    if (this.readOnlyZips.has(zipUriStr))
      throw vscode.FileSystemError.NoPermissions(uri);
  }

  watch(uri: vscode.Uri): vscode.Disposable {
    const [zipUriStr, zipUri, entryPath] = this.parseUri(uri);

    let disposables: vscode.Disposable[] = [];
    let lastTime: number | undefined = -1;

    const processChange = (document: ZipDocument | undefined) => {
      const newTime = document?.zip.getEntry(entryPath)?.header.timeval;

      if (lastTime === undefined && newTime !== undefined) {
        this.onDidChangeFileEmitter.fire([
          { type: vscode.FileChangeType.Created, uri },
        ]);
      } else if (lastTime !== undefined && newTime === undefined) {
        this.onDidChangeFileEmitter.fire([
          { type: vscode.FileChangeType.Deleted, uri },
        ]);
      } else if (lastTime !== newTime) {
        this.onDidChangeFileEmitter.fire([
          { type: vscode.FileChangeType.Changed, uri },
        ]);
      }

      lastTime = newTime;
    };

    const reWatch = () => {
      disposables.forEach((d) => d.dispose());
      disposables = [this.watch(uri)];
    };

    const document = this.documentMap.get(zipUriStr);
    if (document) {
      disposables.push(
        document.onDidChange(() => processChange(document)),
        document.onDidDispose(() => reWatch()),
      );
    } else {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(zipUri, "*"),
      );
      disposables.push(
        watcher,
        watcher.onDidChange(() => ZipDocument.open(zipUri).then(processChange)),
        watcher.onDidCreate(() => ZipDocument.open(zipUri).then(processChange)),
        watcher.onDidDelete(() => processChange(undefined)),
        this.onDidAddZipDocument(
          ([addedZipUriStr]) => addedZipUriStr === zipUriStr && reWatch(),
        ),
      );
    }

    return new vscode.Disposable(() => disposables.forEach((d) => d.dispose()));
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const [zipUriStr] = this.parseUri(uri);
    const [document, entryPath] = await this.readUri(uri);
    let entry = document?.zip.getEntry(entryPath);

    // Breadcrumb traversal support
    if (!entry) {
      if (this.isRoot(uri)) {
        return {
          type: vscode.FileType.Directory,
          ctime: Date.now(),
          mtime: Date.now(),
          size: 0,
          permissions: this.readOnlyZips.has(zipUriStr)
            ? vscode.FilePermission.Readonly
            : undefined,
        };
      } else {
        entry = document?.zip.getEntry(entryPath + "/");
      }
    }

    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);

    return {
      type: entry.isDirectory
        ? vscode.FileType.Directory
        : vscode.FileType.File,
      ctime: entry.header.time?.getTime() ?? Date.now(),
      mtime: entry.header.time?.getTime() ?? Date.now(),
      size: entry.header.size,
      permissions: this.readOnlyZips.has(zipUriStr)
        ? vscode.FilePermission.Readonly
        : undefined,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const [document, entryPath] = await this.readUri(uri);
    if (!document) throw vscode.FileSystemError.FileNotFound(uri);

    const children =
      document.zip
        .getEntries()
        .filter(
          (e) =>
            e.entryName.startsWith(entryPath) &&
            e.entryName !== entryPath &&
            e.entryName.slice(entryPath.length).split("/").filter(Boolean)
              .length === 1,
        ) ?? [];

    return children.map((e) => [
      e.entryName.slice(entryPath.length).replace(/^\//, ""),
      e.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    this.assertWritable(uri);

    const [document, entryPath] = await this.readUri(uri);
    if (!document) throw vscode.FileSystemError.FileNotFound(uri);

    const entry = document.zip.getEntry(entryPath);
    if (entry) throw vscode.FileSystemError.FileExists(uri);

    document.zip.addFile(
      entryPath.endsWith("/") ? entryPath : entryPath + "/",
      Buffer.from([]),
    );
    await document.save();
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const [document, entryPath] = await this.readUri(uri);

    const entry = document?.zip.getEntry(entryPath);
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);

    return entry.getData();
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    this.assertWritable(uri);

    const [document, entryPath] = await this.readUri(uri);
    if (!document) throw vscode.FileSystemError.FileNotFound(uri);

    const entry = document.zip.getEntry(entryPath);

    if (!entry) {
      if (!options.create) throw vscode.FileSystemError.FileNotFound(uri);
      document.zip.addFile(entryPath, Buffer.from(content));
    } else {
      if (!options.overwrite) throw vscode.FileSystemError.FileExists(uri);
      entry.header.time = new Date();
      document.zip.updateFile(entry, Buffer.from(content));
    }

    await document.save();
  }

  async delete(
    uri: vscode.Uri,
    options: { recursive: boolean },
  ): Promise<void> {
    this.assertWritable(uri);

    const [document, entryPath] = await this.readUri(uri);
    if (!document) throw vscode.FileSystemError.FileNotFound(uri);

    const entry = document.zip.getEntry(entryPath);

    // Folders can exist without an entry of their own, through the entries they contain
    if (!entry) {
      const children = entryPath.endsWith("/")
        ? document.zip
            .getEntries()
            .filter((e) => e.entryName.startsWith(entryPath))
        : [];

      if (children.length === 0) throw vscode.FileSystemError.FileNotFound(uri);
      if (!options.recursive) throw vscode.FileSystemError.NoPermissions(uri);

      for (const child of children) {
        document.zip.deleteFile(child, true);
      }

      await document.save();
      return;
    }

    if (entry.isDirectory && !options.recursive) {
      const childrenCount = document.zip.childCount(entry);
      if (childrenCount > 0) throw vscode.FileSystemError.NoPermissions(uri);
    }

    document.zip.deleteFile(entryPath, true);
    await document.save();
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean },
  ): Promise<void> {
    this.assertWritable(oldUri);

    const stat = await this.stat(oldUri);

    if (stat.type === vscode.FileType.Directory) {
      await this.createDirectory(newUri);

      for (const [childName] of await this.readDirectory(oldUri)) {
        await this.rename(
          vscode.Uri.joinPath(oldUri, childName),
          vscode.Uri.joinPath(newUri, childName),
          options,
        );
      }
    } else {
      const data = await this.readFile(oldUri);
      await this.writeFile(newUri, data, {
        create: true,
        overwrite: options.overwrite,
      });
    }

    await this.delete(oldUri, { recursive: true });
  }
}

export function activateEntryStatusItem(
  zipEntryFS: ZipEntryFileSystem,
): vscode.Disposable[] {
  const editorItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99.99,
  );
  editorItem.text = "Zip Editor";
  editorItem.tooltip =
    "File is being read from a zip file editor. Click to open.";

  const noEditorItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99.99,
  );
  noEditorItem.text = "No Zip Editor";
  noEditorItem.tooltip =
    "Containing zip file not open. Reading directly from file system. Click to open.";
  noEditorItem.color = new vscode.ThemeColor("statusBarItem.warningForeground");
  noEditorItem.backgroundColor = new vscode.ThemeColor(
    "statusBarItem.warningBackground",
  );

  let activeUri: vscode.Uri | undefined;
  let activeDocumentListener: vscode.Disposable | undefined;

  const showNoEditor = () => {
    activeDocumentListener?.dispose();
    activeDocumentListener = undefined;

    noEditorItem.command = {
      command: "zipKit.openContainingZip",
      title: "Open Zip Editor",
      arguments: [activeUri],
    };

    editorItem.hide();
    noEditorItem.show();
  };

  const showEditor = (document: ZipDocument) => {
    activeDocumentListener?.dispose();
    activeDocumentListener = document.onDidDispose(() => showNoEditor());

    editorItem.command = {
      command: "zipKit.openContainingZip",
      title: "Show Zip Editor",
      arguments: [activeUri],
    };

    editorItem.show();
    noEditorItem.hide();
  };

  const hideBoth = () => {
    activeDocumentListener?.dispose();
    activeDocumentListener = undefined;

    editorItem.hide();
    noEditorItem.hide();
  };

  const handleTabChange = () => {
    activeUri = (
      vscode.window.tabGroups.activeTabGroup.activeTab?.input as
        | { uri?: vscode.Uri }
        | undefined
    )?.uri;
    if (activeUri?.scheme !== zipEntryScheme) return hideBoth();
    const document = zipEntryFS.getZipFile(activeUri);
    document ? showEditor(document) : showNoEditor();
  };

  return [
    editorItem,
    noEditorItem,
    zipEntryFS.onDidAddZipDocument(([addedZipUriStr, document]) => {
      if (activeUri?.toString() !== addedZipUriStr) return;
      showEditor(document);
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => handleTabChange()),
    vscode.window.tabGroups.onDidChangeTabs(() => handleTabChange()),
    new vscode.Disposable(() => activeDocumentListener?.dispose()),
  ];
}
