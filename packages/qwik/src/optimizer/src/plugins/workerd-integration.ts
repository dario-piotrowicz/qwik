import { createWorkerdViteFunctions, type WorkerdFunctions } from 'workerd-vite-utils';
import type { ViteDevServer } from 'vite';

import {
  RequestEvLoaders,
  RequestEvMode,
  RequestEvQwikSerializer,
  RequestEvRoute,
  RequestEvTrailingSlash,
} from 'packages/qwik-city/middleware/request-handler/request-event';
import type { QwikManifest } from '../types';

let workerdFunctions: ReturnType<typeof createWorkerdViteFunctions> | null = null;

export function getWorkerdFunctions(server: ViteDevServer): WorkerdFunctions {
  if (!workerdFunctions) {
    workerdFunctions = createWorkerdViteFunctions({
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
          const newLoadedRouteModules = [];
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
      },
    });
  }
  return workerdFunctions;
}

/**
 * RenderOpts (of type RenderToStreamOptions) is not serializable so we need try to generate a
 * serialized renderOpts (it needs to be serialized so that it can be passed to workerd) in the
 * process we throw away anything that can't be serialized, the result seems to still produce a
 * working app, but we do need to understand the implications here, are the things that we filter
 * out here not needed for rendering the html?
 */
export function getSerializedRenderOpts(
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
  const serializedRenderOpts = JSON.parse(JSON.stringify(renderOpts));
  return serializedRenderOpts;
}
