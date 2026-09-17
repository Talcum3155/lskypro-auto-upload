import {
  MarkdownView,
  Plugin,
  Editor,
  Menu,
  Notice,
  addIcon,
  requestUrl,
  MarkdownFileInfo,
  TFile,
} from "obsidian";

import { posix, parse } from "path";

import imageType from "image-type";

import {
  isAssetTypeAnImage,
  getUrlAsset,
} from "./utils";
import { LskyProUploader } from "./uploader";
import Helper from "./helper";

import { SettingTab, PluginSettings, DEFAULT_SETTINGS } from "./setting";

interface Image {
  path: string;
  obspath: string;
  name: string;
  source: string;
}

export default class imageAutoUploadPlugin extends Plugin {
  settings: PluginSettings;
  helper: Helper;
  editor: Editor;
  lskyUploader: LskyProUploader;
  uploader: LskyProUploader;
  private batchRunning = false;

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() { }

  async onload() {
    await this.loadSettings();
    this.helper = new Helper(this.app);
    this.lskyUploader = new LskyProUploader(this.settings,this.app);
    if (this.settings.uploader === "LskyPro") {
      this.uploader = this.lskyUploader;
    } else {
      new Notice("unknown uploader");
    }

    addIcon(
      "upload",
      `<svg t="1636630783429" class="icon" viewBox="0 0 100 100" version="1.1" p-id="4649" xmlns="http://www.w3.org/2000/svg">
      <path d="M 71.638 35.336 L 79.408 35.336 C 83.7 35.336 87.178 38.662 87.178 42.765 L 87.178 84.864 C 87.178 88.969 83.7 92.295 79.408 92.295 L 17.249 92.295 C 12.957 92.295 9.479 88.969 9.479 84.864 L 9.479 42.765 C 9.479 38.662 12.957 35.336 17.249 35.336 L 25.019 35.336 L 25.019 42.765 L 17.249 42.765 L 17.249 84.864 L 79.408 84.864 L 79.408 42.765 L 71.638 42.765 L 71.638 35.336 Z M 49.014 10.179 L 67.326 27.688 L 61.835 32.942 L 52.849 24.352 L 52.849 59.731 L 45.078 59.731 L 45.078 24.455 L 36.194 32.947 L 30.702 27.692 L 49.012 10.181 Z" p-id="4650" fill="#8a8a8a"></path>
    </svg>`
    );

    this.addSettingTab(new SettingTab(this.app, this));

    this.addCommand({
      id: "Upload all images",
      name: "Upload all images-All images in the current file",
      checkCallback: (checking: boolean) => {
        let leaf = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (leaf) {
          if (!checking) {
            const file = this.app.workspace.getActiveFile();
            this.uploadAllFile(file!);
          }
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "Download all images",
      name: "Download all images",
      checkCallback: (checking: boolean) => {
        let leaf = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (leaf) {
          if (!checking) {
            this.downloadAllImageFiles();
          }
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "Upload all images in all notes (reuse)",
      name: "Upload all images - All notes in vault (reuse)",
      checkCallback: (checking: boolean) => {
        const hasMarkdown = this.app.vault
          .getFiles()
          .some(f => f.path.endsWith(".md"));
        if (hasMarkdown) {
          if (!checking) {
            this.uploadAllNotesByUploadAllFile();
          }
          return true;
        }
        return false;
      },
    });

    this.setupPasteHandler();
    this.registerSelection();
  }

  registerSelection() {
    this.registerEvent(
      this.app.workspace.on(
        "editor-menu",
        (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
          if (this.app.workspace.getLeavesOfType("markdown").length === 0) {
            return;
          }
          const selection = editor.getSelection();
          if (selection) {
            const markdownRegex = /!\[.*\]\((.*)\)/g;
            const markdownMatch = markdownRegex.exec(selection);
            if (markdownMatch && markdownMatch.length > 1) {
              const markdownUrl = markdownMatch[1];
              if (
                (this.settings.uploadedImages || []).find(
                  (item: { imgUrl: string }) => item.imgUrl === markdownUrl
                )
              ) {
                //TODO 选中连接，右键可以上传
                //this.addMenu(menu, markdownUrl, editor);
              }
            }
          }
        }
      )
    );
  }

  async downloadAllImageFiles() {
    if (this.batchRunning) { new Notice("已有批量任务正在运行"); return; }
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    this.batchRunning = true;
    try {
      const originalPath = file.path;
      const content = await this.helper.readFile(file);
      const images = this.helper.getImageLink(content).filter(image => /^https?:\/\//i.test(image.path));
      const folder = this.getAttachmentFolderPath(file);
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      const downloaded = new Map<string, string>();
      const replacements = new Map<string, string>();
      let failed = 0;
      for (const image of images) {
        try {
          let path = downloaded.get(image.path);
          if (!path) {
            const response = await requestUrl({ url: image.path });
            if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
            const type = await imageType(new Uint8Array(response.arrayBuffer));
            if (!type) throw new Error("无法识别图片格式");
            let asset = getUrlAsset(image.path);
            try { asset = decodeURIComponent(asset); } catch { /* Preserve malformed URL names. */ }
            const name = parse(asset).name.replace(/[\\/:*?"<>|]/g, "-") || "image";
            path = posix.join(folder, `${name}.${type.ext}`);
            for (let index = 1; this.app.vault.getAbstractFileByPath(path); index++) path = posix.join(folder, `${name}-${index}.${type.ext}`);
            await this.app.vault.createBinary(path, response.arrayBuffer);
            downloaded.set(image.path, path);
          }
          replacements.set(image.source, this.imageMarkdown(image.name, encodeURI(path)));
        } catch (error) { failed++; new Notice(`下载失败：${String(error)}`); }
      }
      if (file.path !== originalPath) throw new Error("下载期间笔记已移动，请重试");
      if (replacements.size) await this.helper.updateFile(file, value => this.helper.replaceLinks(value, replacements), content);
      new Notice(`下载完成：成功 ${images.length - failed}，失败 ${failed}`);
    } catch (error) { new Notice(`下载失败：${String(error)}`); }
    finally { this.batchRunning = false; }
  }

  getAttachmentFolderPath(file: TFile) {
    const configured: string = (this.app.vault as any).config?.attachmentFolderPath || "";
    if (configured === "." || configured === "./") return (file.parent?.path || "").replace(/^\/+|\/+$/g, "");
    const folder = configured.startsWith("./")
      ? posix.join(file.parent?.path || "", configured.slice(2)) : configured;
    return folder.replace(/^\/+|\/+$/g, "");
  }

  filterFile(fileArray: Image[]) {
    const imageList: Image[] = [];

    for (const match of fileArray) {
      if (/^https?:\/\//i.test(match.path)) {
        if (this.settings.workOnNetWork) {
          if (
            !this.helper.hasBlackDomain(
              match.path,
              this.settings.newWorkBlackDomains
            )
          ) {
            imageList.push({
              path: match.path,
              obspath: match.path,
              name: match.name,
              source: match.source,
            });
          }
        }
      } else {
        imageList.push({
          path: match.path,
          obspath: match.obspath,
          name: match.name,
          source: match.source,
        });
      }
    }

    return imageList;
  }
  private imageMarkdown(name: string, url: string) {
    const alt = `${name}${this.settings.imageSizeSuffix || ""}`.replace(/[\[\]\r\n]/g, " ");
    return `![${alt}](${url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
  }

  async uploadAllFile(currentFile?: TFile) {
    const file = currentFile ?? this.app.workspace.getActiveFile();
    if (!file) { new Notice("没有打开的文件"); return; }
    await this.runUploadBatch([file]);
  }

  async uploadAllNotesByUploadAllFile() {
    await this.runUploadBatch(this.app.vault.getMarkdownFiles());
  }

  private async runUploadBatch(files: TFile[]) {
    if (this.batchRunning) { new Notice("已有批量任务正在运行"); return; }
    this.batchRunning = true;
    const cache = new Map<string, string>();
    const candidates = new Map<TFile, { mtime: number; size: number }>();
    let success = 0, skipped = 0, failed = 0;
    try {
      for (const file of files) {
        try {
          const changed = await this.uploadNote(file, cache, candidates);
          if (changed) success++; else skipped++;
        } catch (error) {
          failed++;
          new Notice(`${file.path}：${String(error)}`);
        }
      }
      if (this.settings.deleteSource) await this.cleanUploadedSources(candidates);
      new Notice(`处理完成：成功 ${success}，跳过 ${skipped}，失败 ${failed}`);
    } catch (error) {
      new Notice(`批量任务失败：${String(error)}`);
    } finally {
      this.batchRunning = false;
    }
  }

  private async uploadNote(file: TFile, cache: Map<string, string>, candidates: Map<TFile, { mtime: number; size: number }>) {
    if (this.helper.getFrontmatterValue("image-auto-upload", true, file) === false) return false;
    const originalPath = file.path;
    const content = await this.helper.readFile(file);
    const images = this.filterFile(this.helper.getImageLink(content));
    const replacements = new Map<string, string>();
    const localFiles = new Map<TFile, { mtime: number; size: number }>();
    for (const image of images) {
      const remote = /^https?:\/\//i.test(image.path);
      const local = remote ? null : this.helper.resolveImage(image.path, file);
      if (!remote && (!local || !isAssetTypeAnImage(local.path))) {
        // Non-image embeds are expected; missing image references are failures.
        if (!local && isAssetTypeAnImage(image.path)) throw new Error(`找不到图片：${image.path}`);
        continue;
      }
      const snapshot = local ? { mtime: local.stat.mtime, size: local.stat.size } : null;
      const path = local ? local.path : image.path;
      const key = local ? JSON.stringify([path, snapshot!.mtime, snapshot!.size]) : path;
      let url = cache.get(key);
      if (!url) {
        const result = await this.uploader.uploadFilesByPath([path]);
        if (!result.success || !result.result[0]) throw new Error(result.msg || "上传失败");
        url = result.result[0];
        cache.set(key, url);
      }
      replacements.set(image.source, this.imageMarkdown(image.name || local?.name || "image", url));
      if (local) localFiles.set(local, snapshot!);
    }
    if (!replacements.size) return false;
    if (file.path !== originalPath) throw new Error("上传期间笔记已移动，请重试");
    for (const [local, snapshot] of localFiles) {
      if (local.stat.mtime !== snapshot.mtime || local.stat.size !== snapshot.size) throw new Error("上传期间源图片已修改，请重试");
    }
    await this.helper.updateFile(file, value => this.helper.replaceLinks(value, replacements), content);
    for (const [local, snapshot] of localFiles) candidates.set(local, snapshot);
    return true;
  }

  private async cleanUploadedSources(candidates: Map<TFile, { mtime: number; size: number }>) {
    // Read actual files instead of trusting the asynchronously updated link cache.
    // Name matches deliberately retain ambiguous references, including code and
    // Canvas links. Saved and unsaved content must both be free of references.
    let retained = 0;
    for (const [image, snapshot] of candidates) {
      if (this.app.vault.getAbstractFileByPath(image.path) !== image ||
          image.stat.mtime !== snapshot.mtime || image.stat.size !== snapshot.size) { retained++; continue; }
      let referenced = false;
      for (const note of this.app.vault.getFiles().filter(file => ["md", "canvas"].includes(file.extension))) {
        const saved = await this.app.vault.read(note);
        const current = note.extension === "md" ? await this.helper.readFile(note) : saved;
        const needle = image.name.toLowerCase();
        // Decode individual escapes so malformed percent signs don't hide links.
        const contains = (text: string) => {
          // A successfully replaced image may retain its old filename as alt
          // text. External image labels do not reference a local source.
          // Resolve extensionless Wiki/Markdown links too: ![[image]] may
          // reference image.png even though the filename never appears in text.
          const links = this.helper.getImageLink(text);
          for (const link of links) {
            if (!/^https?:\/\//i.test(link.path) && this.helper.resolveImage(link.path, note) === image) return true;
          }
          for (const match of text.matchAll(/\[\[([^\]|#\n]+)(?:[^\]\n]*)\]\]/g)) {
            if (this.helper.resolveImage(match[1], note) === image) return true;
          }
          // Cached ordinary links are an additional conservative guard. Stale
          // entries can retain a file, but cannot authorize deleting one.
          if (this.app.metadataCache.resolvedLinks?.[note.path]?.[image.path]) return true;
          const remoteImages = links.filter(link => /^https?:\/\//i.test(link.path));
          text = this.helper.replaceLinks(text, new Map(remoteImages.map(link => [link.source, ""])));
          let decoded = text;
          try { decoded = decodeURIComponent(text); } catch {
            decoded = text.replace(/(?:%[0-9a-f]{2})+/gi, part => { try { return decodeURIComponent(part); } catch { return part; } });
          }
          return decoded.toLowerCase().includes(needle) || text.includes(encodeURIComponent(image.name));
        };
        if (contains(saved) || contains(current)) { referenced = true; break; }
      }
      if (referenced) { retained++; continue; }
      // Recheck after asynchronous reads; modified originals must never be removed.
      if (this.app.vault.getAbstractFileByPath(image.path) !== image || image.stat.mtime !== snapshot.mtime || image.stat.size !== snapshot.size) { retained++; continue; }
      await this.app.vault.trash(image, false);
    }
    if (retained) new Notice(`保留 ${retained} 张仍被引用、尚未保存替换结果或已修改的源图片`);
  }

  setupPasteHandler() {
    this.registerEvent(this.app.workspace.on("editor-paste", (evt: ClipboardEvent, editor: Editor, view: MarkdownView) => {
      const data = evt.clipboardData;
      const file = view.file;
      if (!data || !file || evt.defaultPrevented || !this.helper.getFrontmatterValue("image-auto-upload", this.settings.uploadByClipSwitch, file)) return;
      if (this.canUpload(data)) {
        const files = Array.from(data.files).filter(file => file.type.startsWith("image/"));
        evt.preventDefault();
        void this.uploadAndInsert(file, editor, files);
        return;
      }
      if (!this.settings.workOnNetWork) return;
      const text = data.getData("text/plain");
      const images = this.helper.getImageLink(text).filter(image => /^https?:\/\//i.test(image.path) && !this.helper.hasBlackDomain(image.path, this.settings.newWorkBlackDomains));
      if (!images.length) return;
      evt.preventDefault();
      const marker = this.newMarker();
      editor.replaceSelection(marker);
      void (async () => {
        let replacement = text;
        try {
          const paths = [...new Set(images.map(image => image.path))];
          const result = await this.uploader.uploadFilesByPath(paths);
          if (!result.success) throw new Error(result.msg || "上传失败");
          const urls = new Map(paths.map((path, index) => [path, result.result[index]]));
          replacement = this.helper.replaceLinks(text, new Map(images.map(image => [image.source, this.imageMarkdown(image.name, urls.get(image.path)!)])));
        } catch (error) {
          new Notice(`上传失败，保留原始链接：${String(error)}`);
        }
        try { await this.replaceMarker(file, marker, replacement); }
        catch (error) { new Notice(`粘贴内容写回失败：${String(error)}`); }
      })();
    }));
    this.registerEvent(this.app.workspace.on("editor-drop", (evt: DragEvent, editor: Editor, view: MarkdownView) => {
      const files = Array.from(evt.dataTransfer?.files ?? []);
      const file = view.file;
      if (!file || evt.defaultPrevented || !files.length || !files.every(item => item.type.startsWith("image/")) ||
          !this.helper.getFrontmatterValue("image-auto-upload", this.settings.uploadByClipSwitch, file)) return;
      evt.preventDefault();
      void this.uploadAndInsert(file, editor, files);
    }));
  }

  private newMarker() { return `![Uploading file...${crypto.randomUUID()}]()`; }

  private async replaceMarker(file: TFile, marker: string, replacement: string) {
    await this.helper.updateFile(file, text => text.replace(marker, () => replacement));
  }

  private async uploadAndInsert(note: TFile, editor: Editor, files: File[]) {
    // Insert placeholders before awaiting requests so cursor movement cannot
    // change the destination. Each dropped image retains its own filename.
    const markers = files.map(() => this.newMarker());
    editor.replaceSelection(markers.join("\n") + "\n");
    for (let index = 0; index < files.length; index++) {
      let result;
      try { result = await this.uploader.promiseRequest(files[index]); }
      catch (error) { result = { code: -1, data: "", msg: String(error) }; }
      try {
        await this.replaceMarker(note, markers[index], result.code === 0
          ? this.imageMarkdown(files[index].name, result.data)
          : "⚠️ 图片上传失败，请重新粘贴或拖拽");
      } catch (error) {
        new Notice(`图片链接写回失败：${String(error)}`);
      }
      if (result.code !== 0) new Notice(result.msg);
    }
  }

  canUpload(clipboardData: DataTransfer) {
    const files = clipboardData.files;
    const text = clipboardData.getData("text");

    const hasImageFile =
      files.length !== 0 && files[0].type.startsWith("image");
    if (hasImageFile) {
      if (!!text) {
        return this.settings.applyImage;
      } else {
        return true;
      }
    } else {
      return false;
    }
  }

}
