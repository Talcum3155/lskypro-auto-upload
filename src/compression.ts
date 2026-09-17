import type { PluginSettings } from "./setting";

// Only recompress known static raster formats. Preserve GIF/WebP/AVIF animation
// and SVG vectors by leaving those formats untouched.
export async function compressImage(file: File, settings: PluginSettings): Promise<File> {
  if (!settings.compressImages || file.size < settings.compressionMinKB * 1024) return file;
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const bmp = bytes[0] === 66 && bytes[1] === 77;
  if (!png && !jpeg && !bmp) return file;
  if (png) {
    const data = new DataView(await file.arrayBuffer());
    for (let offset = 8; offset + 12 <= data.byteLength;) {
      const length = data.getUint32(offset);
      const type = data.getUint32(offset + 4);
      if (type === 0x6163544c) return file; // APNG acTL
      if (type === 0x49444154) break; // IDAT
      offset += length + 12;
    }
  }

  const url = URL.createObjectURL(file);
  let canvas: HTMLCanvasElement | undefined;
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Cannot decode image"));
      image.src = url;
    });
    const max = Number(settings.compressionMaxDimension);
    const scale = Number.isFinite(max) && max > 0
      ? Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight)) : 1;
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const quality = Number(settings.compressionQuality);
    const blob = await new Promise<Blob | null>(resolve => canvas!.toBlob(
      resolve, "image/webp", Number.isFinite(quality) ? Math.max(0.1, Math.min(1, quality)) : 0.85
    ));
    // Unsupported WebP encoders may silently produce PNG. Keep the original.
    if (!blob || blob.type !== "image/webp" || blob.size >= file.size) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "image"}.webp`, {
      type: "image/webp", lastModified: file.lastModified,
    });
  } finally {
    URL.revokeObjectURL(url);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
