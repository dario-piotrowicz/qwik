// IMPORTANT! this clearly a terrible place for a ts file, I am setting it here
// just as I hack around

import { createWorkerdViteFunctions, type WorkerdFunctions } from 'workerd-vite-utils';
import type { ViteDevServer } from 'vite';
import { RequestEvLoaders, RequestEvMode, RequestEvQwikSerializer, RequestEvRoute, RequestEvTrailingSlash } from './qwik-city/middleware/request-handler/request-event';

export function getWorkerdFunctions(server: ViteDevServer): WorkerdFunctions {
  if((globalThis as any).workerdFunctions) {
    return (globalThis as any).workerdFunctions;
  } else {
    (globalThis as any).workerdFunctions = createWorkerdViteFunctions({
      server: server as any,
      functions: {
        renderApp: async ({ data, viteImport, ctx }) => {
          const { entryPoint, renderOpts, srcBase } = data as {
            entryPoint: string;
            renderOpts: any;
            srcBase: string;
          };
          const entrypointModule = (await viteImport(entryPoint)) as {
            default?: (renderOpts: any) => Promise<void>;
            render?: (renderOpts: any) => Promise<void>;
          };

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

          const getSymbolHash = (symbolName: string) => {
            const index = symbolName.lastIndexOf('_');
            if (index > -1) {
              return symbolName.slice(index + 1);
            }
            return symbolName;
          };
          renderOpts.symbolMapper = (symbolName: string, mapper: Record<string, unknown>) => {
            const defaultChunk = [
              symbolName,
              '/' + srcBase + '/' + symbolName.toLowerCase() + '.js',
            ];
            if (mapper) {
              const hash = getSymbolHash(symbolName);
              return mapper[hash] ?? defaultChunk;
            } else {
              return defaultChunk;
            }
          };
          renderOpts.stream = stream;
          const newLoadedRouteModules: any[] = [];
          for (const entry of renderOpts.serverData.qwikcity.loadedRoute[2]) {
            const mod = await viteImport(entry.__filePath);
            newLoadedRouteModules.push(mod);
          }
          renderOpts.serverData.qwikcity.loadedRoute[2] = newLoadedRouteModules;

          const render = entrypointModule.default ?? entrypointModule.render;

          // Note: this is unlikely to be the correct behavior, can we indeed close
          // the stream as soon as the render function completes?
          const renderPromise = render!(renderOpts).finally(() => stream.close());

          ctx.waitUntil(renderPromise);

          const html = await response.text();
          return html;
        },
        runLoader: async ({ data, env, viteImport }) => {
          const { moduleFilePath, loaderName, requestEv } = data as {
            loaderName: string;
            moduleFilePath: string;
            requestEv: any,
          };

          requestEv.platform.env = {
            ...requestEv.platform.env ?? {},
            ...env,
          };

          const mod: any = await viteImport(moduleFilePath);

          const loader = mod[loaderName];

          const result = await loader.__qrl.call(requestEv, requestEv);

          return JSON.parse(JSON.stringify(result));
        },
      },
    });
  }
  return (globalThis as any).workerdFunctions;
}

export function serializeRequestEv(ev: any) {
  return {
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
  };
}