import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
export function loadSource(entry, mocks) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    new Function('require', 'module', 'exports', compiled)(specifier => {
      if (specifier in mocks) return mocks[specifier];
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier + '.ts'));
      return require(specifier);
    }, module, module.exports);
    return module.exports;
  }
  return load(new URL('../src/' + entry, import.meta.url).pathname);
}
