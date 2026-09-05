Zip adds first-class archive support to VS Code: build zip archives from the Explorer, extract them anywhere, browse their contents in a dedicated tree view, and edit the files inside them with the regular VS Code editors — no temporary folders, no round trips outside the editor.

## Features

- **Create zip archives** from any selection of files and folders, with optional store-only (uncompressed) output.
- **Extract zip archives** — either the whole archive or a single entry — with per-file overwrite prompts.
- **Browse archives** in the _Zip_ view, backed by a virtual file system so entries open in normal editors.
- **Modify archives in place**: add, rename, move, and delete entries, including drag and drop.
- **Works with zip-based formats** such as `.vsix`, `.jar`, `.xlsx`, or `.epub` via a configurable extension list.

## Usage

### Zipping

Right-click files or folders in the Explorer and choose **Zip...**, or run one of the Command Palette commands. A native folder picker asks where to save the archive, followed by an input box for the file name with a **Compress Zip** inline toggle (off writes entries uncompressed, compression method `0`) and a back button to return to the folder picker.

When zipping a single folder, its contents are nested under the folder's name inside the archive unless `zip.actions.zip.removeTopLevelFolder` is set to `yes`. When multiple items are selected, paths inside the archive are made relative to their closest common directory. Progress is reported per entry, and the finished archive can be opened straight from the notification.

### Unzipping

Right-click a zip archive and choose **Unzip...**, or use **Zip: Unzip Archive...** to pick one from a dialog. A native folder picker asks where to extract the contents. Existing files trigger an overwrite prompt with _Overwrite_, _Skip_, and _…All_ choices. Set `zip.actions.unzip.addFileNameToPath` to `yes` to extract into a new subfolder named after the archive instead of directly into the selected folder.

Individual entries can be extracted the same way from the **Unzip...** item in the _Zip_ view's context menu.

### Browsing and editing

Clicking a zip archive in the Explorer opens it in the **Zip** view in the Secondary Side Bar rather than in an editor tab. From there:

- Toggle **Make Read-only** / **Make Read-write** to guard an archive against accidental edits. The lock applies to the tree view and to any editor opened from it. Newly opened archives start read-only unless `zip.archives.defaultOpenMode` is set to `editable`.
- Click an entry to open it in a normal editor. Saving writes the change back into the archive.
- Use **New File...**, **New Folder...**, **Rename or Move...**, and **Delete** on entries.
- Drag files or folders from the Explorer (or your OS) onto an entry to add them to the archive; drag entries within the view to move them, or between two open archives to copy them.
- Drag a zip archive onto the empty area of the view to open it.
- **Pin** an archive to keep it in the view. Unpinned archives are replaced when another archive is opened, and pinned archives are restored when the workspace is reopened.

A status bar item shows whether the file in the active editor is being read through an open zip archive (**Extracted from Zip**) or directly from disk because the archive is closed (**Extracted from Closed Zip**); clicking it reveals or opens the containing archive. The same action is available as **Go to Containing Zip Archive** in the editor title bar.

## Commands

| Command                             | Description                                                 |
| ----------------------------------- | ----------------------------------------------------------- |
| `Zip: Zip...`                       | Zip the selected Explorer items or the active editor's file |
| `Zip: Zip Files...`                 | Pick files with a dialog, then zip them                     |
| `Zip: Zip Folders...`               | Pick folders with a dialog, then zip them                   |
| `Zip: Unzip...`                     | Extract the selected zip file or the active editor's file   |
| `Zip: Unzip Archive...`             | Pick a zip file with a dialog, then extract it              |
| `Zip: Open Zip Archive...`          | Pick a zip file with a dialog and open it in the _Zip_ view |
| `Zip: Go to Containing Zip Archive` | Reveal the archive that the active editor's file belongs to |
| `Zip: Reload`                       | Re-read the open archives from disk                         |
| `Zip: Open Settings`                | Open the extension's settings                               |

## Settings

| Setting                                | Default             | Description                                                                                                        |
| -------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `zip.archives.defaultOpenMode`         | `"read-only"`       | Whether archives opened in the _Zip_ view are `read-only` or `editable`                                            |
| `zip.fileExtensions`                   | `[".zip", ".vsix"]` | File extensions treated as zip files by the Explorer context menu and the file dialogs                             |
| `zip.actions.zip.removeTopLevelFolder` | `"no"`              | When zipping a single folder, whether to zip its contents directly instead of nesting them under the folder's name |
| `zip.actions.unzip.addFileNameToPath`  | `"no"`              | Whether to extract into a new subfolder named after the archive instead of directly into the selected folder       |

Replace the list to add your own formats or to narrow it down. Example:

```json
"zip.fileExtensions": [".zip", ".ear", ".jar", ".war"]
```

Those files open in the _Zip_ view instead of an editor tab when they are left-clicked. This is automatically achieved by keeping one entry per extension in `workbench.editorAssociations` in your user settings. (This is a workaround for VS Code's default behavior that does not allow to automatically open files from the Explorer in a custom view). Example:

```json
"workbench.editorAssociations": {
	"*.zip": "zip.redirectToTree",
	"*.ear": "zip.redirectToTree",
	"*.jar": "zip.redirectToTree",
	"*.war": "zip.redirectToTree"
}
```

The entries follow `zip.fileExtensions` as it changes, and are removed again when the extension is uninstalled.

## How it works (under the hood)

Archive entries are exposed through a `zip:` file system provider, using URIs of the form:

```
zip://<url-encoded-zip-file-uri>/<zip-file-name>/<entry-path>
```

The zip archive's own location is carried by the authority alone, so entry paths stay relative to the zip archive, the same way Explorer paths stay relative to the workspace. So it is possible to navigate within the archive just like you would within a regular folder structure, using the tree view or the breadcrumb navigation at the top of the editor.

Because entries are ordinary VS Code resources, they work with the standard editors, diffs, language features, and Save. Writes are applied to the in-memory archive and flushed back to the underlying zip archive.

## Compatibility

- Requires VS Code `1.109.0` or newer.
- Supported in both real and virtual workspaces.
- Reads and writes through `vscode.workspace.fs`, so archives on remote and virtual file systems work as well as local ones.

## Acknowledgments

This extension is based on [ZipKit](https://marketplace.visualstudio.com/items?itemName=brandonfowler.zip-kit) by Brandon Fowler.

## License

[GPL-3.0-or-later](LICENSE)
