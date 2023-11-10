/* eslint-disable no-console */
import { magenta } from 'kleur/colors';
import type { IncomingMessage, ServerResponse } from 'http';

import type { Connect, ViteDevServer } from 'vite';
import type { OptimizerSystem, Path, QwikManifest } from '../types';
import { type NormalizedQwikPluginOptions, parseId } from './plugin';
import type { QwikViteDevResponse } from './vite';
import { formatError } from './vite-utils';
import { VITE_ERROR_OVERLAY_STYLES } from './vite-error';
import imageDevTools from './image-size-runtime.html?raw';
import clickToComponent from './click-to-component.html?raw';
import perfWarning from './perf-warning.html?raw';
import errorHost from './error-host.html?raw';

import { createWorkerdHandler } from 'workerd-vite-utils';
import {
  RequestEvLoaders,
  RequestEvMode,
  RequestEvQwikSerializer,
  RequestEvRoute,
  RequestEvTrailingSlash,
} from 'packages/qwik-city/middleware/request-handler/request-event';

function getOrigin(req: IncomingMessage) {
  const { PROTOCOL_HEADER, HOST_HEADER } = process.env;
  const headers = req.headers;
  const protocol =
    (PROTOCOL_HEADER && headers[PROTOCOL_HEADER.toLowerCase()]) ||
    ((req.socket as any).encrypted || (req.connection as any).encrypted ? 'https' : 'http');
  const host =
    (HOST_HEADER && headers[HOST_HEADER.toLowerCase()]) || headers[':authority'] || headers['host'];

  return `${protocol}://${host}`;
}

export async function configureDevServer(
  server: ViteDevServer,
  opts: NormalizedQwikPluginOptions,
  sys: OptimizerSystem,
  path: Path,
  isClientDevOnly: boolean,
  clientDevInput: string | undefined
) {
  if (typeof fetch !== 'function' && sys.env === 'node') {
    // polyfill fetch() when not available in Node.js

    try {
      if (!globalThis.fetch) {
        const undici = await sys.strictDynamicImport('undici');
        globalThis.fetch = undici.fetch;
        globalThis.Headers = undici.Headers;
        globalThis.Request = undici.Request;
        globalThis.Response = undici.Response;
        globalThis.FormData = undici.FormData;
      }
    } catch {
      console.warn('Global fetch() was not installed');
      // Nothing
    }
  }

  const srcBase = opts.srcDir
    ? path.relative(opts.rootDir, opts.srcDir).replace(/\\/g, '/')
    : 'src';

  const workerdHandler = createWorkerdHandler({
    entrypoint: opts.input[0],
    server: server as any,
    requestHandler: async ({ entrypointModule, request }) => {
      const { writable, readable } = new TransformStream();
      const response = new Response(readable, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
        },
      });
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const stream = {
        write(chunk: any) {
          writer.write(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        },
        close() {
          writer.close();
        },
      };

      let renderOpts = null;
      try {
        renderOpts = JSON.parse(request.headers.get('x-workerd-rendering-opts') ?? 'null');
        const getSymbolHash = (symbolName: string) => {
          const index = symbolName.lastIndexOf('_');
          if (index > -1) {
            return symbolName.slice(index + 1);
          }
          return symbolName;
        };
        const srcBase = JSON.parse(request.headers.get('x-workerd-src-base') ?? 'null');
        renderOpts.symbolMapper = (symbolName: string, mapper: Record<string, unknown>) => {
          const defaultChunk = [symbolName, '/' + srcBase + '/' + symbolName.toLowerCase() + '.js'];
          if (mapper) {
            const hash = getSymbolHash(symbolName);
            return mapper[hash] ?? defaultChunk;
          } else {
            return defaultChunk;
          }
        };
        renderOpts.stream = stream;
        const newLoadedRouteModules = [];
        for (const entry of renderOpts.serverData.qwikcity.loadedRoute[2]) {
          //@ts-ignore
          const mod = await __vite_ssr_dynamic_import__(entry.__filePath);
          newLoadedRouteModules.push(mod);
        }
        renderOpts.serverData.qwikcity.loadedRoute[2] = newLoadedRouteModules;
      } catch (e) {
        renderOpts = null;
      }

      const render = entrypointModule.default ?? entrypointModule.render;

      await render(renderOpts);
      // const result = ctx.waitUntil(render(renderOpts));

      stream.close();

      return response;
    },
  });

  // qwik middleware injected BEFORE vite internal middlewares
  server.middlewares.use(async (req: any, res: any, next: any) => {
    try {
      const { ORIGIN } = process.env;
      const domain = ORIGIN ?? getOrigin(req);
      const url = new URL(req.originalUrl!, domain);

      if (shouldSsrRender(req, url)) {
        const serverData: Record<string, any> = {
          ...(res as QwikViteDevResponse)._qwikEnvData,
          url: url.href,
        };

        const status = typeof res.statusCode === 'number' ? res.statusCode : 200;
        if (isClientDevOnly) {
          const relPath = path.relative(opts.rootDir, clientDevInput!);
          const entryUrl = '/' + relPath.replace(/\\/g, '/');

          let html = getViteDevIndexHtml(entryUrl, serverData);
          html = await server.transformIndexHtml(url.pathname, html);

          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-store, max-age=0');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('X-Powered-By', 'Qwik Vite Dev Server');
          res.writeHead(status);

          res.end(html);
          return;
        }

        const manifest: QwikManifest = {
          manifestHash: '',
          symbols: {},
          mapping: {},
          bundles: {},
          injections: [],
          version: '1',
        };

        const added = new Set();
        Array.from(server.moduleGraph.fileToModulesMap.entries()).forEach((entry) => {
          entry[1].forEach((v) => {
            const hook = v.info?.meta?.hook;
            let url = v.url;
            if (v.lastHMRTimestamp) {
              url += `?t=${v.lastHMRTimestamp}`;
            }
            if (hook) {
              manifest.mapping[hook.name] = relativeURL(url, opts.rootDir);
            }

            const { pathId, query } = parseId(v.url);
            if (query === '' && ['.css', '.scss', '.sass'].some((ext) => pathId.endsWith(ext))) {
              added.add(v.url);
              manifest.injections!.push({
                tag: 'link',
                location: 'head',
                attributes: {
                  rel: 'stylesheet',
                  href: url,
                },
              });
            }
          });
        });

        const msg = {
          headers: {},
        } as IncomingMessage;
        msg.url = req.url;
        msg.method = 'GET';

        const serializedRenderOpts = getSerializedRenderOpts(serverData, isClientDevOnly, manifest);
        msg.headers['x-workerd-rendering-opts'] = serializedRenderOpts;
        msg.headers['x-workerd-src-base'] = JSON.stringify(srcBase);

        const resp = await workerdHandler(msg);
        // let's just read the whole stream here (this can be improved later)
        const text = await resp.text();

        const renderResult = resp;

        if (renderResult) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-store, max-age=0');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('X-Powered-By', 'Qwik Vite Dev Server');
          res.writeHead(status);

          // Sometimes new CSS files are added after the initial render
          Array.from(server.moduleGraph.fileToModulesMap.entries()).forEach((entry) => {
            entry[1].forEach((v) => {
              const { pathId, query } = parseId(v.url);
              if (
                !added.has(v.url) &&
                query === '' &&
                ['.css', '.scss', '.sass'].some((ext) => pathId.endsWith(ext))
              ) {
                res.write(`<link rel="stylesheet" href="${v.url}">`);
              }
            });
          });

          res.write(text);
          // Qwik question: I haven't encountered this html field, in which cases it is used?
          // (if it's needed we need to add this bit in the workerd code above)
          // End stream
          // if ('html' in renderResult) {
          //   res.write((renderResult as any).html);
          // }
          res.write(
            END_SSR_SCRIPT(opts, opts.srcDir ? opts.srcDir : path.join(opts.rootDir, 'src'))
          );
          res.end();
        } else {
          next();
        }
      } else {
        next();
      }
    } catch (e: any) {
      if (e instanceof Error) {
        server.ssrFixStacktrace(e);
        await formatError(sys, e);
      }
      next(e);
    } finally {
      if (typeof (res as QwikViteDevResponse)._qwikRenderResolve === 'function') {
        (res as QwikViteDevResponse)._qwikRenderResolve!();
      }
    }
  });

  server.middlewares.use(function (err: any, _req: any, res: ServerResponse, next: any) {
    if (!res.writableEnded) {
      res.write(`<style>${VITE_ERROR_OVERLAY_STYLES}</style>`);
    }
    return next(err);
  });

  setTimeout(() => {
    console.log(`\n  ❗️ ${magenta('Expect significant performance loss in development.')}`);
    console.log(`  ❗️ ${magenta("Disabling the browser's cache results in waterfall requests.")}`);
  }, 1000);
}

export async function configurePreviewServer(
  middlewares: Connect.Server,
  ssrOutDir: string,
  sys: OptimizerSystem,
  path: Path
) {
  const fs: typeof import('fs') = await sys.dynamicImport('node:fs');
  const url: typeof import('url') = await sys.dynamicImport('node:url');

  const entryPreviewPaths = ['mjs', 'cjs', 'js'].map((ext) =>
    path.join(ssrOutDir, `entry.preview.${ext}`)
  );

  const entryPreviewModulePath = entryPreviewPaths.find((p) => fs.existsSync(p));
  if (!entryPreviewModulePath) {
    return invalidPreviewMessage(
      middlewares,
      `Unable to find output "${ssrOutDir}/entry.preview" module.\n\nPlease ensure "src/entry.preview.tsx" has been built before the "preview" command.`
    );
  }

  try {
    const entryPreviewImportPath = url.pathToFileURL(entryPreviewModulePath).href;
    const previewModuleImport = await sys.strictDynamicImport(entryPreviewImportPath);

    let previewMiddleware: Connect.HandleFunction | null = null;
    let preview404Middleware: Connect.HandleFunction | null = null;

    if (previewModuleImport.default) {
      if (typeof previewModuleImport.default === 'function') {
        previewMiddleware = previewModuleImport.default;
      } else if (typeof previewModuleImport.default === 'object') {
        previewMiddleware = previewModuleImport.default.router;
        preview404Middleware = previewModuleImport.default.notFound;
      }
    }

    if (typeof previewMiddleware !== 'function') {
      return invalidPreviewMessage(
        middlewares,
        `Entry preview module "${entryPreviewModulePath}" does not export a default middleware function`
      );
    }

    middlewares.use(previewMiddleware);

    if (typeof preview404Middleware === 'function') {
      middlewares.use(preview404Middleware);
    }
  } catch (e) {
    return invalidPreviewMessage(middlewares, String(e));
  }
}

function invalidPreviewMessage(middlewares: Connect.Server, msg: string) {
  console.log(`\n❌ ${msg}\n`);

  middlewares.use((_, res) => {
    res.writeHead(400, {
      'Content-Type': 'text/plain',
    });
    res.end(msg);
  });
}

const FS_PREFIX = `/@fs/`;
const VALID_ID_PREFIX = `/@id/`;
const VITE_PUBLIC_PATH = `/@vite/`;
const internalPrefixes = [FS_PREFIX, VALID_ID_PREFIX, VITE_PUBLIC_PATH];
const InternalPrefixRE = new RegExp(`^(?:${internalPrefixes.join('|')})`);

const shouldSsrRender = (req: IncomingMessage, url: URL) => {
  const pathname = url.pathname;
  if (/\.[\w?=&]+$/.test(pathname) && !pathname.endsWith('.html')) {
    // has extension
    return false;
  }
  if (pathname.includes('_-vite-ping')) {
    return false;
  }
  if (pathname.includes('__open-in-editor')) {
    return false;
  }
  if (url.searchParams.has('html-proxy')) {
    return false;
  }
  if (url.searchParams.get('ssr') === 'false') {
    return false;
  }
  if (InternalPrefixRE.test(url.pathname)) {
    return false;
  }
  if (pathname.includes('@builder.io/qwik/build')) {
    return false;
  }
  const acceptHeader = req.headers.accept || '';
  const accepts = acceptHeader.split(',').map((accept) => accept.split(';')[0]);
  if (accepts.length == 1 && accepts.includes('*/*')) {
    // special case for curl where the default is `*/*` with no additional headers
    return true;
  }

  if (!accepts.includes('text/html')) {
    return false;
  }
  return true;
};

declare global {
  interface Window {
    __qwik_inspector_state: {
      pressedKeys: string[];
      hoveredElement?: EventTarget | null;
    };
  }
}

function relativeURL(url: string, base: string) {
  if (url.startsWith(base)) {
    url = url.slice(base.length);
    if (!url.startsWith('/')) {
      url = '/' + url;
    }
  }
  return url;
}

const DEV_QWIK_INSPECTOR = (opts: NormalizedQwikPluginOptions['devTools'], srcDir: string) => {
  const qwikdevtools = {
    hotKeys: opts.clickToSource ?? [],
    srcDir: new URL(srcDir + '/', 'http://local.local').href,
  };
  return (
    `<script>
      globalThis.qwikdevtools = ${JSON.stringify(qwikdevtools)};
    </script>` +
    imageDevTools +
    (opts.clickToSource ? clickToComponent : '')
  );
};

const END_SSR_SCRIPT = (opts: NormalizedQwikPluginOptions, srcDir: string) => `
<style>${VITE_ERROR_OVERLAY_STYLES}</style>
<script type="module" src="/@vite/client"></script>
${errorHost}
${perfWarning}
${DEV_QWIK_INSPECTOR(opts.devTools, srcDir)}
`;

function getViteDevIndexHtml(entryUrl: string, serverData: Record<string, any>) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
  </head>
  <body>
    <script type="module">
    async function main() {
      const mod = await import("${entryUrl}?${VITE_DEV_CLIENT_QS}=");
      if (mod.default) {
        const serverData = JSON.parse(${JSON.stringify(JSON.stringify(serverData))})
        mod.default({
          serverData,
        });
      }
    }
    main();
    </script>
    ${errorHost}
  </body>
</html>`;
}

export const VITE_DEV_CLIENT_QS = `qwik-vite-dev-client`;

export const getSymbolHash = (symbolName: string) => {
  const index = symbolName.lastIndexOf('_');
  if (index > -1) {
    return symbolName.slice(index + 1);
  }
  return symbolName;
};

/**
 * RenderOpts (of type RenderToStreamOptions) is not serializable so we need try to generate a
 * serialized renderOpts (it needs to be serialized so that it can be passed to workerd) in the
 * process we throw away anything that can't be serialized, the result seems to still produce a
 * working app, but we do need to understand the implications here, are the things that we filter
 * out here not needed for rendering the html?
 */
function getSerializedRenderOpts(
  serverData: Record<string, any>,
  isClientDevOnly: boolean,
  manifest: QwikManifest
) {
  const { qwikcity, ...serializableServerData } = serverData;
  const { ev, ...serializableQwikcity } = qwikcity;

  const renderOpts = {
    debug: true,
    locale: serverData.locale,
    snapshot: !isClientDevOnly,
    manifest: isClientDevOnly ? undefined : manifest,
    prefetchStrategy: null,
    serverData: {
      ...serializableServerData,
      qwikcity: serializableQwikcity,
      ev: {
        [RequestEvLoaders]: ev[RequestEvLoaders],
        [RequestEvMode]: ev[RequestEvMode],
        [RequestEvQwikSerializer]: ev[RequestEvQwikSerializer],
        [RequestEvRoute]: ev[RequestEvRoute],
        [RequestEvTrailingSlash]: ev[RequestEvTrailingSlash],
        basePathname: ev.basePathname,
        method: ev.method,
        params: ev.params,
        pathname: ev.pathname,
        platform: {
          ssr: true,
          node: ev.platform.node,
        },
        url: ev.url,
      },
    },
    containerAttributes: {
      ...serverData.containerAttributes,
    },
  };
  const serializedRenderOpts = JSON.stringify(renderOpts);
  return serializedRenderOpts;
}
