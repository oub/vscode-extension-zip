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

import * as vscode from "vscode";
import {
  openContainingZip,
  selectAndOpen,
  selectAndUnzip,
  selectAndZip,
  unzip,
  zip,
} from "./actions";
import { activateZipEditorRedirect, ZipTree, ZipTreeNode } from "./tree";
import { activateZipFileExtensions } from "./zipFileExtensions";
import {
  activateEntryStatusItem as activateEntryStatusBarItem,
  ZipFileSystem,
} from "./zipFileSystem";

export const zipScheme = "zip-file";
export const zipViewId = "zip.entries"; // TODO rename to "zip.explorer"
export const zipEditorViewType = "zip.redirectToTree";

export function activate(context: vscode.ExtensionContext): void {
  const zipFileSystem = new ZipFileSystem();
  const treeProvider = new ZipTree(zipFileSystem, context.workspaceState);

  treeProvider.restore();

  context.subscriptions.push(
    treeProvider,
    // zip-file://<url-encoded-zip-file-uri>/<zip-file-path>/<entry-path>
    vscode.workspace.registerFileSystemProvider(zipScheme, zipFileSystem, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
    vscode.commands.registerCommand("zip.zip", zip),
    vscode.commands.registerCommand("zip.zip.files", () => selectAndZip(false)),
    vscode.commands.registerCommand("zip.zip.folders", () =>
      selectAndZip(true),
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
    ...activateZipFileExtensions(),
    ...activateEntryStatusBarItem(zipFileSystem),
  );
}
