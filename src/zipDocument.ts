import AdmZip from "adm-zip";
import * as vscode from "vscode";

export const zipDocumentReloaders = new Map<string, () => Promise<void>>();

//TODO:rename to Archive
export class ZipDocument {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private readonly onDidDisposeEmitter = new vscode.EventEmitter<void>();
  private readonly boundReload = this.reload.bind(this);

  readonly onDidChange = this.onDidChangeEmitter.event;
  readonly onDidDispose = this.onDidDisposeEmitter.event;

  private static async getMTime(uri: vscode.Uri): Promise<number | undefined> {
    try {
      return (await vscode.workspace.fs.stat(uri)).mtime;
    } catch {
      return undefined;
    }
  }

  private static async readZip(uri: vscode.Uri) {
    // Stat first so writes made while reading are not mistaken for the read contents
    const mtime = await ZipDocument.getMTime(uri);
    const zip = new AdmZip(
      Buffer.from(await vscode.workspace.fs.readFile(uri)),
    );
    return { zip, mtime };
  }

  static async open(uri: vscode.Uri): Promise<ZipDocument> {
    const { zip, mtime } = await ZipDocument.readZip(uri);
    return new ZipDocument(uri, zip, mtime);
  }

  private constructor(
    public readonly uri: vscode.Uri,
    private _zip: AdmZip,
    private mtime: number | undefined,
  ) {
    zipDocumentReloaders.set(uri.toString(), this.boundReload);
  }

  get zip(): AdmZip {
    return this._zip;
  }

  async reload() {
    const { zip, mtime } = await ZipDocument.readZip(this.uri);

    this._zip = zip;
    this.mtime = mtime;
    this.onDidChangeEmitter.fire();
  }

  // Skips reloading writes made through save to avoid reacting to our own changes
  async reloadIfModified() {
    const mtime = await ZipDocument.getMTime(this.uri);
    if (mtime !== undefined && mtime === this.mtime) return;

    await this.reload();
  }

  async save() {
    await vscode.workspace.fs.writeFile(this.uri, this.zip.toBuffer());
    this.mtime = await ZipDocument.getMTime(this.uri);
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    if (zipDocumentReloaders.get(this.uri.toString()) === this.boundReload) {
      zipDocumentReloaders.delete(this.uri.toString());
    }

    this.onDidDisposeEmitter.fire();
  }
}
