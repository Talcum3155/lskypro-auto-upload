import { compressImage } from "./compression";
import type { PluginSettings } from "./setting";
import { App, TFile } from "obsidian";

export interface UploadResult {
  code: number;
  msg: string;
  data: string;
}
export interface BatchUploadResult {
  success: boolean;
  result: string[];
  msg?: string;
}

export class LskyProUploader {
  constructor(public settings: PluginSettings, public app: App) {}

  private filenameTimestamp = "";
  private filenameSuffixes = new Set<string>();

  private uploadFilename(file: File): string {
    const date = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    if (timestamp !== this.filenameTimestamp) {
      this.filenameTimestamp = timestamp;
      this.filenameSuffixes.clear();
    }
    let suffix: string;
    do { suffix = crypto.randomUUID().slice(0, 4); } while (this.filenameSuffixes.has(suffix));
    this.filenameSuffixes.add(suffix);
    const mimeExtensions: Record<string, string> = {
      "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg",
      "image/gif": "gif", "image/svg+xml": "svg", "image/bmp": "bmp",
      "image/tiff": "tiff", "image/avif": "avif", "image/apng": "png",
    };
    const extension = mimeExtensions[file.type.toLowerCase()] || /\.([a-z0-9]+)$/i.exec(file.name)?.[1].toLowerCase();
    return `${timestamp}-${suffix}${extension ? `.${extension}` : ""}`;
  }

  // Read current settings for each request, including changes made after startup.
  get lskyUrl() {
    const server = this.settings.uploadServer.trim().replace(/\/+$/, "");
    const url = new URL(server);
    if (!/^https?:$/.test(url.protocol) || url.search || url.hash) {
      throw new Error("请填写有效的 HTTP/HTTPS 图床地址");
    }
    return `${server}/api/v1/upload`;
  }

  get lskyToken() {
    const token = this.settings.token.trim().replace(/^Bearer\s+/i, "");
    if (!token) throw new Error("请先配置图床 Token");
    return `Bearer ${token}`;
  }

  getRequestOptions(file: File): RequestInit {
    const headers = new Headers({ Authorization: this.lskyToken, Accept: "application/json" });
    const body = new FormData();
    // This runs after compression, so the extension matches the uploaded format.
    // Only the multipart filename changes; the local original is untouched.
    body.append("file", file, this.uploadFilename(file));
    if (this.settings.strategy_id) body.append("strategy_id", this.settings.strategy_id);
    return { method: "POST", headers, body };
  }

  // Keep the timeout active until the response body has also been consumed.
  private async request<T>(url: string, options: RequestInit, read: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
      return await read(response);
    } finally {
      clearTimeout(timer);
    }
  }

  async promiseRequest(file: File): Promise<UploadResult> {
    try {
      try {
        file = await compressImage(file, this.settings);
      } catch {
        console.warn("Image compression failed; uploading original");
      }
      return await this.request(this.lskyUrl, this.getRequestOptions(file), async response => {
        const value = await response.json();
        const url = value?.data?.links?.url;
        if (value?.status !== true || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          throw new Error(String(value?.message || "图床未返回有效的图片链接"));
        }
        const normalized = new URL(url);
        return { code: 0, msg: "success", data: normalized.href };
      });
    } catch (error) {
      return { code: -1, msg: String(error), data: "" };
    }
  }

  async createFileObjectFromPath(path: string): Promise<File> {
    if (/^https?:\/\//i.test(path)) {
      return this.request(path, {}, async response => {
        const blob = await response.blob();
        if (!blob.size || !blob.type.startsWith("image/")) throw new Error("链接未返回有效的图片");
        const name = new URL(path).pathname.split("/").pop() || "image";
        return new File([blob], name, { type: blob.type });
      });
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`图片不存在：${path}`);
    const data = await this.app.vault.readBinary(file);
    if (!data.byteLength) throw new Error(`图片为空：${path}`);
    const ext = file.extension.toLowerCase();
    const type = ({ jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", tif: "image/tiff" } as Record<string, string>)[ext] || `image/${ext}`;
    return new File([data], file.name, { type });
  }

  // Sequential uploads bound memory use during decoding/compression. A failed
  // batch never returns a shortened URL array that could corrupt link mapping.
  private async uploadBatch(files: Array<File | string>): Promise<BatchUploadResult> {
    const result: string[] = [];
    try {
      for (const item of files) {
        const file = typeof item === "string" ? await this.createFileObjectFromPath(item) : item;
        const uploaded = await this.promiseRequest(file);
        if (uploaded.code !== 0) throw new Error(uploaded.msg);
        result.push(uploaded.data);
      }
      return { success: true, result };
    } catch (error) {
      return { success: false, result: [], msg: String(error) };
    }
  }

  uploadFilesByPath(files: string[]) { return this.uploadBatch(files); }
  uploadFiles(files: File[]) { return this.uploadBatch(files); }

  async uploadFileByClipboard(evt: ClipboardEvent): Promise<UploadResult> {
    const file = evt.clipboardData?.files[0];
    return file ? this.promiseRequest(file) : { code: -1, msg: "剪贴板中没有图片", data: "" };
  }
}
