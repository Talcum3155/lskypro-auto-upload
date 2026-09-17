import { MarkdownView, App, Editor, TFile } from "obsidian";
import { posix } from "path";

export interface ImageLink {
  path: string;
  obspath: string;
  name: string;
  source: string;
  start: number;
  end: number;
}

export default class Helper {
  constructor(public app: App) {}

  getFrontmatterValue(key: string, defaultValue: any = undefined, file = this.app.workspace.getActiveFile()) {
    if (!file) return defaultValue;
    const frontmatter = this.app.metadataCache.getCache(file.path)?.frontmatter;
    return frontmatter && Object.prototype.hasOwnProperty.call(frontmatter, key) ? frontmatter[key] : defaultValue;
  }

  getEditor() { return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null; }
  getValue() { return this.getEditor()?.getValue() ?? ""; }

  private editors(file: TFile): Editor[] {
    return [...new Set(this.app.workspace.getLeavesOfType("markdown")
      .map(leaf => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file === file)
      .map(view => view.editor))];
  }

  async readFile(file: TFile): Promise<string> {
    const editors = this.editors(file);
    if (!editors.length) return this.app.vault.read(file);
    const content = editors[0].getValue();
    if (editors.some(editor => editor.getValue() !== content)) throw new Error("同一笔记的多个编辑器内容不一致，请先保存");
    return content;
  }

  // Resolve editors by file identity at commit time, never by the active tab.
  // A snapshot guards bulk edits; marker replacements operate on current text.
  async updateFile(file: TFile, transform: (content: string) => string, expected?: string) {
    if (this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error("笔记已删除或被替换");
    const check = (content: string) => {
      if (expected !== undefined && content !== expected) throw new Error("上传期间笔记已修改，保留当前内容，请重试");
      return transform(content);
    };
    const editors = this.editors(file);
    if (editors.length) {
      const content = editors[0].getValue();
      if (editors.some(editor => editor.getValue() !== content)) throw new Error("同一笔记的多个编辑器内容不一致，请先保存");
      const updated = check(content);
      for (const editor of editors) {
        if (editor.getValue() !== updated) this.setEditorValue(editor, updated);
      }
    } else {
      await this.app.vault.process(file, content => {
        // Avoid racing a newly opened editor while the vault read was pending.
        if (this.editors(file).length) throw new Error("笔记编辑状态已变化，请重试");
        return check(content);
      });
    }
  }

  private setEditorValue(editor: Editor, value: string) {
    const scroll = (editor as any).getScrollInfo?.();
    const cursor = editor.getCursor();
    editor.setValue(value);
    if (scroll) (editor as any).scrollTo?.(scroll.left, scroll.top);
    editor.setCursor(cursor);
  }

  getAllFiles() { return this.getImageLink(this.getValue()); }

  getImageLink(content: string): ImageLink[] {
    // Mask code without changing offsets so examples are not uploaded/replaced.
    let fence = "";
    const masked = content.split(/(?<=\n)/).map(line => {
      const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (match && match[1][0] === fence[0] && match[1].length >= fence.length && /^\s*$/.test(line.slice(match[0].length))) fence = "";
        return line.replace(/[^\n]/g, " ");
      }
      if (match) { fence = match[1]; return line.replace(/[^\n]/g, " "); }
      return line.replace(/(`+).*?\1/g, value => " ".repeat(value.length));
    }).join("");
    const links: ImageLink[] = [];
    const markdown = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\\()\s]|\([^()\n]*\))+))(?:\s+["'][^\n]*?["'])?\s*\)/g;
    const wiki = /!\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;
    for (const pattern of [markdown, wiki]) {
      for (const match of masked.matchAll(pattern)) {
        const path = pattern === wiki ? match[1] : (match[2] || match[3]);
        const name = pattern === wiki ? (posix.basename(path) + (match[2] ? `|${match[2]}` : "")) : match[1];
        const start = match.index!;
        links.push({ path, obspath: path, name, source: content.slice(start, start + match[0].length), start, end: start + match[0].length });
      }
    }
    return links.sort((a, b) => a.start - b.start);
  }

  replaceLinks(content: string, replacements: Map<string, string>): string {
    for (const link of this.getImageLink(content).reverse()) {
      const replacement = replacements.get(link.source);
      if (replacement !== undefined) content = content.slice(0, link.start) + replacement + content.slice(link.end);
    }
    return content;
  }

  resolveImage(path: string, note: TFile): TFile | null {
    let decoded: string;
    try { decoded = decodeURIComponent(path).replace(/\\([ ()])/g, "$1"); }
    catch { decoded = path; }
    if (decoded.startsWith("./") || decoded.startsWith("../")) {
      const resolved = posix.normalize(posix.join(posix.dirname(note.path), decoded));
      if (resolved.startsWith("../")) return null;
      const file = this.app.vault.getAbstractFileByPath(resolved);
      return file instanceof TFile ? file : null;
    }
    if (decoded.startsWith("/")) {
      const file = this.app.vault.getAbstractFileByPath(decoded.slice(1));
      return file instanceof TFile ? file : null;
    }
    return this.app.metadataCache.getFirstLinkpathDest(decoded, note.path);
  }

  hasBlackDomain(src: string, blackDomains: string) {
    try {
      const domain = new URL(src).hostname.toLowerCase();
      return blackDomains.split(",").map(value => value.trim().toLowerCase()).filter(Boolean)
        .some(blocked => domain === blocked || domain.endsWith(`.${blocked}`));
    } catch { return true; }
  }
}
