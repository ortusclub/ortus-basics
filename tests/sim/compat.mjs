// Node 26 compatibility. @puppeteer/browsers loads its command-line tool at require time, and that does
// require('yargs/yargs'); Node 26 treats that extensionless file as ESM and throws "require is not defined"
// (reproduced on the operator's Mac, Node v26.7.0). The simulator never uses that CLI, so when yargs fails to
// load we hand back an inert stand-in. If yargs loads fine, nothing changes.
import Module from 'node:module';

export function installYargsFallback(M = Module) {
  const original = M._load;
  if (original.__simYargsFallback) return;
  const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  const wrapped = function (request, ...rest) {
    if (typeof request === 'string' && (request === 'yargs' || request.startsWith('yargs/'))) {
      try { return original.call(this, request, ...rest); } catch { return stub; }
    }
    return original.call(this, request, ...rest);
  };
  wrapped.__simYargsFallback = true;
  M._load = wrapped;
}

installYargsFallback();
