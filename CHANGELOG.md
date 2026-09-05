# Changelog

## 0.2.1 — 2026-09-05

- Fix README to reflect the native folder pickers, the Zip file name input box's compression toggle, and the new settings for omitting the top-level folder when zipping and adding the archive name to the path when unzipping.

## 0.2.0 — 2026-09-06

- Use native picker for selecting folders when Zipping or Unzipping for a cleaner experience.
- Prompt before overwriting existing files when creating or extracting archives, with an option to apply the choice to all.
- Add compression options when zipping, including store-only (uncompressed) mode.
- Add an option to omit the top-level folder when zipping, with a folder picker and input box for the zip file name.
- Add a settings command and configurable extraction path options for unzipping.

## 0.1.0 — 2026-09-05

- Add `RO` and `RW` decorators for read-only and read-write archives.
- Rename the **Make Editable** command/setting description to **Make Read-write** for consistency.

## 0.0.8 — 2026-09-04

Initial release.

- Create zip archives from Explorer selections or the active editor, with optional "omit top-level folder" and store-only (uncompressed) modes.
- Extract whole archives or single entries, with per-file overwrite prompts (Overwrite / Skip / …All).
- Browse archives in a dedicated **Zip** view backed by a virtual file system, so entries open in regular editors.
- Edit archives in place: add, rename, move, and delete entries, including drag and drop within and between archives.
- Toggle archives between read-only and editable, with a configurable default open mode.
- Pin archives to keep them in the view across reloads.
- Status bar item and command to jump from an extracted file back to its containing archive.
- Support zip-based formats (`.vsix`, `.jar`, `.xlsx`, `.epub`, etc.) via a configurable `zip.fileExtensions` list, automatically wired into `workbench.editorAssociations`.
