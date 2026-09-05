import * as vscode from "vscode";
import {
  openContainingZip,
  selectAndOpen,
  selectAndUnzip,
  selectAndZip,
  unzip,
  zip,
} from "../out/actions";
import { activateZipEditorRedirect, ZipTree, ZipTreeNode } from "./tree";
import { activateZipFileExtensions } from "./zipFileExtensions";
import {
  activateEntryStatusItem as activateEntryStatusBarItem,
  ZipFileSystem,
} from "./zipFileSystem";

export { zipEditorViewType } from "./settingsPaths";

export const zipScheme = "zip";
export const zipViewId = "zip.explorer";

export let extensionUri: vscode.Uri;

export function activate(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;

  const zipFileSystem = new ZipFileSystem();
  const treeProvider = new ZipTree(zipFileSystem, context.workspaceState);

  treeProvider.restore();

  context.subscriptions.push(
    treeProvider,
    // zip://<url-encoded-zip-file-uri>/<zip-file-path>/<entry-path>
    vscode.workspace.registerFileSystemProvider(zipScheme, zipFileSystem, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
    vscode.commands.registerCommand("zip.zip", zip),
    vscode.commands.registerCommand("zip.zip.files", () => selectAndZip(false)),
    // Shown instead of zip.zip.files when files.simpleDialog.enable is true, since that dialog can't select many
    vscode.commands.registerCommand("zip.zip.file", () =>
      selectAndZip(false, false),
    ),
    vscode.commands.registerCommand("zip.zip.folders", () =>
      selectAndZip(true),
    ),
    // Shown instead of zip.zip.folders when files.simpleDialog.enable is true, since that dialog can't select many
    vscode.commands.registerCommand("zip.zip.folder", () =>
      selectAndZip(true, false),
    ),
    vscode.commands.registerCommand("zip.unzip", unzip),
    vscode.commands.registerCommand("zip.unzip.file", selectAndUnzip),
    vscode.commands.registerCommand(
      "zip.open",
      (uri: vscode.Uri | undefined) => uri && treeProvider.open(uri),
    ),
    vscode.commands.registerCommand("zip.open.file", selectAndOpen),
    vscode.commands.registerCommand(
      "zip.openContainingZip",
      (uri: vscode.Uri | undefined) => openContainingZip(treeProvider, uri),
    ),
    vscode.commands.registerCommand("zip.view.refresh", (node?: ZipTreeNode) =>
      treeProvider.refresh(node),
    ),
    vscode.commands.registerCommand("zip.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:oub.zip",
      ),
    ),
    vscode.commands.registerCommand("zip.view.close", (node: ZipTreeNode) =>
      treeProvider.close(node),
    ),
    vscode.commands.registerCommand("zip.view.pin", (node: ZipTreeNode) =>
      treeProvider.setPinned(node, true),
    ),
    vscode.commands.registerCommand("zip.view.unpin", (node: ZipTreeNode) =>
      treeProvider.setPinned(node, false),
    ),
    vscode.commands.registerCommand("zip.view.unzip", (node: ZipTreeNode) =>
      treeProvider.unzip(node),
    ),
    vscode.commands.registerCommand("zip.view.newFile", (node: ZipTreeNode) =>
      treeProvider.createFile(node),
    ),
    vscode.commands.registerCommand("zip.view.newFolder", (node: ZipTreeNode) =>
      treeProvider.createFolder(node),
    ),
    vscode.commands.registerCommand("zip.view.rename", (node: ZipTreeNode) =>
      treeProvider.rename(node),
    ),
    vscode.commands.registerCommand("zip.view.delete", (node: ZipTreeNode) =>
      treeProvider.delete(node),
    ),
    vscode.commands.registerCommand(
      "zip.view.enableReadOnly",
      (node: ZipTreeNode) => treeProvider.setReadOnly(node, true),
    ),
    vscode.commands.registerCommand(
      "zip.view.disableReadOnly",
      (node: ZipTreeNode) => treeProvider.setReadOnly(node, false),
    ),
    ...activateZipEditorRedirect(treeProvider),
    ...activateZipFileExtensions(context),
    ...activateEntryStatusBarItem(zipFileSystem),
  );
}
