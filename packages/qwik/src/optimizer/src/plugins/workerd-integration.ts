import { createWorkerdHandler } from 'workerd-vite-utils';
import type { NormalizedQwikPluginOptions } from './plugin';
import type { ViteDevServer } from 'vite';
import type { IncomingMessage } from 'node:http';

import {
  RequestEvLoaders,
  RequestEvMode,
  RequestEvQwikSerializer,
  RequestEvRoute,
  RequestEvTrailingSlash,
} from 'packages/qwik-city/middleware/request-handler/request-event';
import type { Path, QwikManifest } from '../types';

export function getWorkerdHandler(
  opts: NormalizedQwikPluginOptions,
  server: ViteDevServer
): (request: IncomingMessage) => Promise<Response> {
  const workerdHandler = createWorkerdHandler({
    entrypoint: opts.input[0],
    server: server as any,
    requestHandler,
  });

  return workerdHandler as unknown as (request: IncomingMessage) => Promise<Response>;
}

async function requestHandler({
  entrypointModule,
  request,
  context,
}: {
  entrypointModule: any;
  request: Request;
  context: { waitUntil: (p: Promise<unknown>) => void }
}) {
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

  // Note: this is unlikely to be the correct behavior, can we indeed close
  // the stream as soon as the render function completes?
  const renderPromise = render(renderOpts).finally(() => stream.close());

  context.waitUntil(renderPromise);

  return response;
}

export function createWorkerdIncomingMessage(
  req: any,
  opts: NormalizedQwikPluginOptions,
  path: Path,
  serverData: Record<string, any>,
  isClientDevOnly: boolean,
  manifest: QwikManifest
) {
  const msg = {
    headers: {},
  } as IncomingMessage;
  msg.url = req.url;
  msg.method = 'GET';

  const srcBase = opts.srcDir
    ? path.relative(opts.rootDir, opts.srcDir).replace(/\\/g, '/')
    : 'src';

  const serializedRenderOpts = getSerializedRenderOpts(serverData, isClientDevOnly, manifest);
  msg.headers['x-workerd-rendering-opts'] = serializedRenderOpts;
  msg.headers['x-workerd-src-base'] = JSON.stringify(srcBase);
  return msg;
}

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
