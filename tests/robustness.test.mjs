import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './load-source.mjs';

class TFile {
  constructor(path, content = '') {
    this.path = path; this.name = path.split('/').pop(); this.extension = this.name.split('.').pop();
    this.parent = { path: path.split('/').slice(0, -1).join('/') };
    this.stat = { mtime: 1, size: 8 }; this.content = content;
  }
}
class MarkdownView {
  constructor(file, content = file.content) {
    this.file = file;
    this.editor = { getValue: () => content, setValue: value => { content = value; },
      getCursor: () => ({ line: 0, ch: 0 }), setCursor() {},
      replaceSelection: value => { content += value; } };
  }
}
const notices = [];
const obsidian = { TFile, MarkdownView, Plugin: class {}, Notice: class { constructor(text) { notices.push(text); } } };
const mocks = { obsidian, './setting': { DEFAULT_SETTINGS: {} }, 'image-type': async () => ({ ext: 'png' }) };
const Helper = loadSource('helper.ts', mocks).default;
const Uploader = loadSource('uploader.ts', mocks).LskyProUploader;
const Plugin = loadSource('main.ts', mocks).default;

function setup(files = [], views = []) {
  const app = {
    workspace: { getLeavesOfType: () => views.map(view => ({ view })), getActiveFile: () => views[0]?.file,
      getActiveViewOfType: () => views[0] },
    vault: {
      getAbstractFileByPath: path => files.find(file => file.path === path),
      getFiles: () => files, getMarkdownFiles: () => files.filter(file => file.extension === 'md'),
      read: async file => file.content,
      readBinary: async () => new Uint8Array([137, 80, 78, 71]).buffer,
      process: async (file, transform) => { file.content = transform(file.content); },
      trash: async file => { files.splice(files.indexOf(file), 1); },
    },
    metadataCache: { getCache: () => ({}), getFirstLinkpathDest: (link, source) => {
      const adjacent = source.split('/').slice(0, -1).concat(link).join('/');
      return files.find(file => file.path === adjacent) || files.find(file => file.path === link) || files.find(file => file.name === link) || null;
    } },
  };
  const helper = new Helper(app);
  const plugin = new Plugin(); plugin.app = app; plugin.helper = helper;
  plugin.settings = { deleteSource: false, workOnNetWork: false, newWorkBlackDomains: '', imageSizeSuffix: '' };
  plugin.uploader = { uploadFilesByPath: async paths => ({ success: true, result: paths.map(() => 'https://img.test/uploaded.webp') }) };
  return { app, helper, plugin, views, files };
}
const settings = () => ({ uploadServer: 'https://img.test/', token: 'token', strategy_id: '', compressImages: false });
const uploadedResponse = () => new Response(JSON.stringify({ status: true, data: { links: { url: 'https://img.test/a.webp' } } }));

test('request errors, invalid JSON, missing URLs, and HTTP failures settle as failures', async t => {
  const uploader = new Uploader(settings(), setup().app);
  for (const impl of [async () => { throw Error('offline'); }, async () => new Response('bad json'),
    async () => new Response('{}'), async () => new Response('{}', { status: 500 }),
    async () => new Response('{"status":false,"message":"denied"}')]) {
    t.mock.method(globalThis, 'fetch', impl);
    const result = await uploader.promiseRequest(new File(['x'], 'a.png'));
    assert.equal(result.code, -1); assert.equal(result.data, '');
  }
});
test('settings changes take effect without restart and Bearer prefix is not duplicated', async t => {
  const config = settings(); const uploader = new Uploader(config, setup().app);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push([url, options.headers.get('Authorization')]); return uploadedResponse(); });
  await uploader.promiseRequest(new File(['x'], 'a.png'));
  config.uploadServer = ' https://new.test/base/ '; config.token = ' Bearer updated ';
  await uploader.promiseRequest(new File(['x'], 'a.png'));
  assert.deepEqual(requests, [['https://img.test/api/v1/upload', 'Bearer token'], ['https://new.test/base/api/v1/upload', 'Bearer updated']]);
});
test('timeout aborts a hung response body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => ({ ok: true, json: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')))) }));
  const pending = new Uploader(settings(), setup().app).promiseRequest(new File(['x'], 'a.png'));
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(60000);
  assert.equal((await pending).code, -1);
});
test('missing files and read failures reject instead of hanging', async () => {
  const file = new TFile('a.png'); const { app } = setup([file]); const uploader = new Uploader(settings(), app);
  await assert.rejects(uploader.createFileObjectFromPath('missing.png'), /图片不存在/);
  app.vault.readBinary = async () => { throw Error('read failed'); };
  assert.equal((await uploader.uploadFilesByPath(['a.png'])).success, false);
});
test('remote image fetch failures and non-images reject', async t => {
  const uploader = new Uploader(settings(), setup().app);
  t.mock.method(globalThis, 'fetch', async () => new Response('missing', { status: 404 }));
  await assert.rejects(uploader.createFileObjectFromPath('https://site.test/a.png'), /404/);
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(uploader.createFileObjectFromPath('https://site.test/a.png'), /图片/);
});
test('partial batch failure never exposes misaligned URL array', async () => {
  const uploader = new Uploader(settings(), setup().app); let count = 0;
  uploader.promiseRequest = async () => ++count === 1 ? { code: 0, data: 'https://img.test/a.png' } : { code: -1, msg: 'failed' };
  const result = await uploader.uploadFiles([new File(['x'], 'a.png'), new File(['x'], 'b.png')]);
  assert.equal(result.success, false); assert.deepEqual(result.result, []);
});
test('switching the active note never overwrites the new note', async () => {
  const a = new TFile('a.md', 'old'); const b = new TFile('b.md', 'other');
  const original = new MarkdownView(a); const other = new MarkdownView(b);
  const { helper, views } = setup([a, b], [original]);
  views[0] = other;
  await helper.updateFile(a, () => 'updated', 'old');
  assert.equal(a.content, 'updated'); assert.equal(other.editor.getValue(), 'other');
});
test('a background open editor is updated by identity', async () => {
  const a = new TFile('a.md', 'old'); const b = new TFile('b.md', 'other');
  const original = new MarkdownView(a); const other = new MarkdownView(b);
  const { helper } = setup([a, b], [other, original]);
  await helper.updateFile(a, () => 'updated', 'old');
  assert.equal(original.editor.getValue(), 'updated'); assert.equal(other.editor.getValue(), 'other');
});
test('edits made while uploading and conflicting editors are preserved', async () => {
  const file = new TFile('a.md', 'old'); const view = new MarkdownView(file, 'new user text');
  const { helper, views } = setup([file], [view]);
  await assert.rejects(helper.updateFile(file, () => 'uploaded', 'old'), /已修改/);
  assert.equal(view.editor.getValue(), 'new user text');
  views.push(new MarkdownView(file, 'different'));
  await assert.rejects(helper.readFile(file), /不一致/);
});
test('atomic disk edit refuses changed content and deleted note', async () => {
  const file = new TFile('a.md', 'new'); const { helper, files } = setup([file]);
  await assert.rejects(helper.updateFile(file, () => 'uploaded', 'old'), /已修改/);
  assert.equal(file.content, 'new'); files.length = 0;
  await assert.rejects(helper.updateFile(file, () => 'uploaded'), /已删除/);
});
test('editor opening during a pending vault operation prevents stale write', async () => {
  const file = new TFile('a.md', 'old'); const { helper, app, views } = setup([file]);
  app.vault.process = async (note, transform) => { views.push(new MarkdownView(note, 'new')); note.content = transform(note.content); };
  await assert.rejects(helper.updateFile(file, () => 'uploaded', 'old'), /状态已变化/);
  assert.equal(file.content, 'old');
});
test('relative, encoded, and source-relative duplicate filenames resolve correctly', () => {
  const note = new TFile('notes/deep/a.md'); const right = new TFile('notes/images/a b.png'); const wrong = new TFile('other/a b.png');
  const { helper } = setup([note, wrong, right]);
  assert.equal(helper.resolveImage('../images/a%20b.png', note), right);
  assert.equal(helper.resolveImage('../../other/a%20b.png', note), wrong);
  assert.equal(helper.resolveImage('../../../other/a%20b.png', note), null);
  assert.equal(helper.resolveImage('../missing/a%20b.png', note), null);
  assert.equal(helper.resolveImage('/notes/images/a%20b.png', note), right);
});
test('Wiki sizing and Markdown paths parse; code examples remain unchanged', () => {
  const { helper } = setup();
  const source = '![[a.png|300]]\n![a](<some image.png>)\n![b](image(1).png)\n`![x](a.png)`\n```md\n![x](a.png)\n```\n![x](a.png)';
  const links = helper.getImageLink(source);
  assert.deepEqual(links.map(link => link.path), ['a.png', 'some image.png', 'image(1).png', 'a.png']);
  const output = helper.replaceLinks(source, new Map([['![x](a.png)', 'UPLOADED']]));
  assert.ok(output.includes('`![x](a.png)`')); assert.ok(output.includes('```md\n![x](a.png)\n```'));
  assert.ok(output.endsWith('UPLOADED'));
});
test('domain filtering handles whitespace, subdomains, and malformed URLs', () => {
  const { helper } = setup();
  assert.equal(helper.hasBlackDomain('https://sub.example.com/a', ' example.com, other.test '), true);
  assert.equal(helper.hasBlackDomain('https://notexample.com/a', 'example.com'), false);
  assert.equal(helper.hasBlackDomain('https://[bad', 'example.com'), true);
});
test('all-note upload reuses shared image and defers deletion until references are replaced', async () => {
  const image = new TFile('image.png'); const a = new TFile('a.md', '![[image.png]]'); const b = new TFile('b.md', '![](image.png)');
  const { plugin, files } = setup([image, a, b]); plugin.settings.deleteSource = true;
  let uploads = 0;
  plugin.uploader.uploadFilesByPath = async () => { uploads++; assert.ok(files.includes(image)); return { success: true, result: ['https://img.test/new.webp'] }; };
  await plugin.uploadAllNotesByUploadAllFile();
  assert.equal(uploads, 1); assert.match(a.content, /https:/); assert.match(b.content, /https:/); assert.ok(!files.includes(image));
});
test('failure leaves note and source intact and does not stop later notes', async () => {
  const first = new TFile('first.png'); const second = new TFile('second.png');
  const a = new TFile('a.md', '![](first.png)'); const b = new TFile('b.md', '![](second.png)');
  const { plugin, files } = setup([first, second, a, b]); plugin.settings.deleteSource = true;
  plugin.uploader.uploadFilesByPath = async paths => paths[0] === 'first.png' ? { success: false, result: [], msg: 'offline' } : { success: true, result: ['https://img.test/new.webp'] };
  await plugin.uploadAllNotesByUploadAllFile();
  assert.equal(a.content, '![](first.png)'); assert.match(b.content, /https:/); assert.ok(files.includes(first));
});
test('source stays when another note, Canvas, or unsaved editor still references it', async () => {
  for (const kind of ['md', 'canvas', 'editor']) {
    const image = new TFile('image.png'); const a = new TFile('a.md', '![](image.png)');
    const b = new TFile(kind === 'canvas' ? 'b.canvas' : 'b.md', kind === 'editor' ? '' : 'image.png');
    const views = kind === 'editor' ? [new MarkdownView(b, '![[image.png]]')] : [];
    const { plugin, files } = setup([image, a, b], views); plugin.settings.deleteSource = true;
    await plugin.uploadAllFile(a); assert.ok(files.includes(image), kind);
  }
});
test('concurrent commands are rejected and frontmatter opt-out is honored', async () => {
  const image = new TFile('image.png'); const a = new TFile('a.md', '![](image.png)');
  const { plugin, app } = setup([image, a]);
  let release; let count = 0;
  plugin.uploader.uploadFilesByPath = () => { count++; return new Promise(resolve => { release = resolve; }); };
  const first = plugin.uploadAllFile(a);
  await Promise.resolve(); await Promise.resolve();
  await plugin.uploadAllFile(a); assert.equal(count, 1);
  release({ success: true, result: ['https://img.test/new.webp'] }); await first;
  app.metadataCache.getCache = () => ({ frontmatter: { 'image-auto-upload': false } });
  a.content = '![](image.png)'; await plugin.uploadAllFile(a); assert.equal(count, 1);
});
test('network images are uploaded when enabled and blacklisted ones stay unchanged', async () => {
  const note = new TFile('a.md', '![](https://source.test/a.png)\n![](https://skip.test/a.png)');
  const { plugin } = setup([note]); plugin.settings.workOnNetWork = true; plugin.settings.newWorkBlackDomains = 'skip.test';
  await plugin.uploadAllFile(note);
  assert.ok(note.content.includes('https://img.test/uploaded.webp')); assert.ok(note.content.includes('https://skip.test/a.png'));
});

test('multi-image insertion keeps order and position with empty alt text after switching tabs and editing', async () => {
  const a = new TFile('a.md', 'before\n'); const b = new TFile('b.md', 'other');
  const original = new MarkdownView(a); const other = new MarkdownView(b);
  const { plugin, views } = setup([a, b], [original]);
  let release; let calls = 0;
  plugin.uploader.promiseRequest = async () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : { code: 0, data: 'https://img.test/two.webp' };
  const pending = plugin.uploadAndInsert(a, original.editor, [new File(['a'], 'one.png'), new File(['b'], 'two.png')]);
  original.editor.setValue(original.editor.getValue() + 'new user text');
  views.unshift(other);
  release({ code: 0, data: 'https://img.test/one.webp' }); await pending;
  assert.equal(original.editor.getValue(), 'before\n![](https://img.test/one.webp)\n![](https://img.test/two.webp)\nnew user text');
  assert.equal(other.editor.getValue(), 'other');
});
test('closing original note writes only its saved marker; undo does not reinsert image', async () => {
  for (const undo of [false, true]) {
    const a = new TFile('a.md'); const b = new TFile('b.md', 'other'); const view = new MarkdownView(a);
    const { plugin, views } = setup([a, b], [view]); let release;
    plugin.uploader.promiseRequest = () => new Promise(resolve => { release = resolve; });
    const pending = plugin.uploadAndInsert(a, view.editor, [new File(['a'], 'one.png')]);
    a.content = undo ? '' : view.editor.getValue(); views[0] = new MarkdownView(b);
    release({ code: 0, data: 'https://img.test/one.webp' }); await pending;
    assert.equal(a.content, undo ? '' : '![](https://img.test/one.webp)\n');
    assert.equal(views[0].editor.getValue(), 'other');
  }
});
test('clipboard upload failure has one failure marker and no undefined URL', async () => {
  const note = new TFile('a.md'); const view = new MarkdownView(note); const { plugin } = setup([note], [view]);
  plugin.uploader.promiseRequest = async () => { throw Error('failure'); };
  await plugin.uploadAndInsert(note, view.editor, [new File(['a'], 'one.png')]);
  assert.match(view.editor.getValue(), /上传失败/); assert.ok(!view.editor.getValue().includes('undefined'));
});
test('source modification during upload aborts writeback and deletion', async () => {
  const image = new TFile('a.png'); const note = new TFile('a.md', '![](a.png)'); const { plugin, files } = setup([image, note]);
  plugin.settings.deleteSource = true;
  plugin.uploader.uploadFilesByPath = async () => { image.stat.mtime++; return { success: true, result: ['https://img.test/a.webp'] }; };
  await plugin.uploadAllFile(note);
  assert.equal(note.content, '![](a.png)'); assert.ok(files.includes(image));
});
test('failed writeback and unreadable reference files prevent source deletion', async () => {
  for (const failure of ['write', 'read']) {
    const image = new TFile('a.png'); const note = new TFile('a.md', '![](a.png)'); const other = new TFile('b.md');
    const { plugin, app, files } = setup([image, note, other]); plugin.settings.deleteSource = true;
    if (failure === 'write') app.vault.process = async () => { throw Error('disk full'); };
    else app.vault.read = async file => { if (file === other) throw Error('unreadable'); return file.content; };
    await plugin.uploadAllFile(note); assert.ok(files.includes(image));
  }
});
test('download waits for file creation and preserves remote link on disk failure', async () => {
  const note = new TFile('a.md', '![](https://img.test/a.png)'); const view = new MarkdownView(note);
  const { app, helper } = setup([note], [view]);
  const DownloadPlugin = loadSource('main.ts', { ...mocks, obsidian: { ...obsidian, requestUrl: async () => ({ status: 200, arrayBuffer: new ArrayBuffer(8) }) } }).default;
  const plugin = new DownloadPlugin(); plugin.app = app; plugin.helper = helper; plugin.settings = {};
  let createCalled = false;
  app.vault.createBinary = async () => { createCalled = true; throw Error('disk full'); };
  await plugin.downloadAllImageFiles(); assert.ok(createCalled);
  assert.equal(view.editor.getValue(), '![](https://img.test/a.png)');
});
test('download after switching tabs writes original note and uses actual detected extension', async () => {
  const note = new TFile('a.md', '![](https://img.test/a.jpg)'); const other = new TFile('b.md', 'other'); const view = new MarkdownView(note);
  const { app, helper, views } = setup([note, other], [view]);
  const DownloadPlugin = loadSource('main.ts', { ...mocks, obsidian: { ...obsidian, requestUrl: async () => {
    views[0] = new MarkdownView(other); return { status: 200, arrayBuffer: new ArrayBuffer(8) };
  } } }).default;
  const plugin = new DownloadPlugin(); plugin.app = app; plugin.helper = helper; plugin.settings = {};
  let saved; app.vault.createBinary = async path => { saved = path; };
  await plugin.downloadAllImageFiles();
  assert.equal(saved, 'a.png'); assert.equal(note.content, '![](a.png)'); assert.equal(views[0].editor.getValue(), 'other');
});
test('network paste failure restores the entire pasted text in the original note', async () => {
  const note = new TFile('a.md'); const other = new TFile('b.md', 'other'); const original = new MarkdownView(note);
  const { plugin, app, views } = setup([note, other], [original]);
  const handlers = new Map(); app.workspace.on = (name, callback) => { handlers.set(name, callback); }; plugin.registerEvent = () => {};
  plugin.settings.uploadByClipSwitch = true; plugin.settings.workOnNetWork = true;
  let release; plugin.uploader.uploadFilesByPath = () => new Promise(resolve => { release = resolve; });
  plugin.setupPasteHandler();
  const text = 'before ![](https://source.test/a.png) after';
  const evt = { clipboardData: { files: [], getData: () => text }, preventDefault() {} };
  handlers.get('editor-paste')(evt, original.editor, original);
  views.unshift(new MarkdownView(other)); release({ success: false, msg: 'offline', result: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(original.editor.getValue(), text); assert.equal(views[0].editor.getValue(), 'other');
});

test('extensionless Wiki references in skipped notes protect shared sources', async () => {
  const image = new TFile('image.png'); const a = new TFile('a.md', '![](image.png)'); const b = new TFile('b.md', '![[image]]');
  const { plugin, app, files } = setup([image, a, b]); plugin.settings.deleteSource = true;
  app.metadataCache.getFirstLinkpathDest = link => ['image', 'image.png'].includes(link) ? image : null;
  await plugin.uploadAllFile(a);
  assert.ok(files.includes(image)); assert.equal(b.content, '![[image]]');
});


test('multipart upload names use local time and random suffix with final image format', async t => {
  const date = new Date(2026, 8, 17, 21, 30, 45);
  t.mock.timers.enable({ apis: ['Date'], now: date.getTime() });
  const uploader = new Uploader(settings(), setup().app);
  const source = new File(['pixels'], 'private-note-title.png', { type: 'image/webp' });
  const first = uploader.getRequestOptions(source).body.get('file');
  const second = uploader.getRequestOptions(source).body.get('file');
  assert.match(first.name, /^20260917-213045-[a-f0-9]{4}\.webp$/);
  assert.notEqual(first.name, second.name);
  assert.equal(first.type, 'image/webp');
  assert.equal(await first.text(), 'pixels');
  assert.equal(source.name, 'private-note-title.png');
  const png = uploader.getRequestOptions(new File(['png'], 'image.png', { type: 'image/png' })).body.get('file');
  assert.match(png.name, /\.png$/);
});
test('Markdown omits alt text while preserving configured and existing image dimensions', () => {
  const { plugin } = setup();
  assert.equal(plugin.imageMarkdown('image.png', 'https://img.test/a.webp'), '![](https://img.test/a.webp)');
  assert.equal(plugin.imageMarkdown('diagram.png|300x200', 'https://img.test/a.webp'), '![|300x200](https://img.test/a.webp)');
  plugin.settings.imageSizeSuffix = '|600';
  assert.equal(plugin.imageMarkdown('diagram.png|300', 'https://img.test/a.webp'), '![|600](https://img.test/a.webp)');
});
