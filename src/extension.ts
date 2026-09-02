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
} from "./zipActions";
import {
  activateEntryStatusItem as activateEntryStatusBarItem,
  ZipEntryFileSystem,
} from "./zipEntryFS";
import { activateZipFileExtensions } from "./zipFileExtensions";
import {
  activateZipEditorRedirect,
  ZipTreeNode,
  ZipTreeProvider,
} from "./zipTreeView";

export const zipEntryScheme = "zip-kit-entry";
export const zipViewId = "zipKit.entries";
export const zipEditorViewType = "zipKit.zipEditor";

export function activate(context: vscode.ExtensionContext): void {
  const zipEntryFS = new ZipEntryFileSystem();
  const treeProvider = new ZipTreeProvider(zipEntryFS, context.workspaceState);

  treeProvider.restore();

  context.subscriptions.push(
    treeProvider,
    // zip-kit-entry://<url-encoded-zip-file-uri>/<zip-file-path>/<entry-path>
    vscode.workspace.registerFileSystemProvider(zipEntryScheme, zipEntryFS, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
    vscode.commands.registerCommand("zipKit.zip", zip),
    vscode.commands.registerCommand("zipKit.zip.files", () =>
      selectAndZip(false),
    ),
    vscode.commands.registerCommand("zipKit.zip.folders", () =>
      selectAndZip(true),
    ),
    vscode.commands.registerCommand("zipKit.unzip", unzip),
    vscode.commands.registerCommand("zipKit.unzip.file", selectAndUnzip),
    vscode.commands.registerCommand(
      "zipKit.open",
      (uri: vscode.Uri | undefined) => uri && treeProvider.open(uri),
    ),
    vscode.commands.registerCommand("zipKit.open.file", selectAndOpen),
    vscode.commands.registerCommand(
      "zipKit.openContainingZip",
      (uri: vscode.Uri | undefined) => openContainingZip(treeProvider, uri),
    ),
    vscode.commands.registerCommand(
      "zipKit.view.refresh",
      (node?: ZipTreeNode) => treeProvider.refresh(node),
    ),
    vscode.commands.registerCommand("zipKit.view.close", (node: ZipTreeNode) =>
      treeProvider.close(node),
    ),
    vscode.commands.registerCommand("zipKit.view.pin", (node: ZipTreeNode) =>
      treeProvider.setPinned(node, true),
    ),
    vscode.commands.registerCommand("zipKit.view.unpin", (node: ZipTreeNode) =>
      treeProvider.setPinned(node, false),
    ),
    vscode.commands.registerCommand("zipKit.view.unzip", (node: ZipTreeNode) =>
      treeProvider.unzip(node),
    ),
    vscode.commands.registerCommand(
      "zipKit.view.newFile",
      (node: ZipTreeNode) => treeProvider.createFile(node),
    ),
    vscode.commands.registerCommand(
      "zipKit.view.newFolder",
      (node: ZipTreeNode) => treeProvider.createFolder(node),
    ),
    vscode.commands.registerCommand("zipKit.view.rename", (node: ZipTreeNode) =>
      treeProvider.rename(node),
    ),
    vscode.commands.registerCommand("zipKit.view.delete", (node: ZipTreeNode) =>
      treeProvider.delete(node),
    ),
    vscode.commands.registerCommand(
      "zipKit.view.enableReadOnly",
      (node: ZipTreeNode) => treeProvider.setReadOnly(node, true),
    ),
    vscode.commands.registerCommand(
      "zipKit.view.disableReadOnly",
      (node: ZipTreeNode) => treeProvider.setReadOnly(node, false),
    ),
    ...activateZipEditorRedirect(treeProvider),
    ...activateZipFileExtensions(),
    ...activateEntryStatusBarItem(zipEntryFS),
  );
}
