import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = ts.transpileModule(readFileSync(new URL('../src/compression.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 },
}).outputText;
const { compressImage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const settings = { compressImages: true, compressionMinKB: 0, compressionQuality: .85, compressionMaxDimension: 0 };
const original = new File([new Uint8Array([255, 216, 255]), new Uint8Array(2048)], 'photo.jpg');
let encodedType = 'image/webp';
let encodedSize = 100;
let canvas;
let quality;
globalThis.Image = class {
  naturalWidth = 4000;
  naturalHeight = 2000;
  set src(value) { queueMicrotask(() => this.onload()); }
};
globalThis.document = { createElement() {
  canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }),
    toBlob(callback, type, q) {
      quality = q;
      this.drawnWidth = this.width;
      this.drawnHeight = this.height;
      callback(new Blob([new Uint8Array(encodedSize)], { type: encodedType }));
    } };
  return canvas;
} };
test('disabled, small, and unsupported files stay identical', async () => {
  assert.equal(await compressImage(original, { ...settings, compressImages: false }), original);
  assert.equal(await compressImage(original, { ...settings, compressionMinKB: 256 }), original);
  const gif = new File(['GIF89a'], 'animation.gif');
  assert.equal(await compressImage(gif, settings), gif);
});
test('APNG stays animated and untouched', async () => {
  const bytes = new Uint8Array(20);
  bytes.set([137, 80, 78, 71]);
  new DataView(bytes.buffer).setUint32(12, 0x6163544c);
  const apng = new File([bytes], 'animation.png');
  assert.equal(await compressImage(apng, settings), apng);
});
test('smaller WebP uses correct extension, quality and original dimensions', async () => {
  const result = await compressImage(original, settings);
  assert.equal(result.name, 'photo.webp');
  assert.equal(result.type, 'image/webp');
  assert.equal(result.size, 100);
  assert.equal(quality, .85);
  assert.equal(canvas.drawnWidth, 4000);
  assert.equal(canvas.drawnHeight, 2000);
  assert.equal(canvas.width, 0);
});
test('optional resizing preserves aspect ratio', async () => {
  await compressImage(original, { ...settings, compressionMaxDimension: 2000 });
  assert.equal(canvas.drawnWidth, 2000);
  assert.equal(canvas.drawnHeight, 1000);
});
test('larger output and unsupported encoder preserve original', async () => {
  encodedSize = 3000;
  assert.equal(await compressImage(original, settings), original);
  encodedSize = 100;
  encodedType = 'image/png';
  assert.equal(await compressImage(original, settings), original);
});
