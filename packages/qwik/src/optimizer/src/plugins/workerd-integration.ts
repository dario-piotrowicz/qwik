import { createWorkerdHandler } from 'workerd-vite-utils';
import type { NormalizedQwikPluginOptions } from './plugin';
import type { ViteDevServer } from 'vite';
import type { IncomingMessage } from 'node:http';

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
}: {
  entrypointModule: any;
  request: Request;
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

  await render(renderOpts);
  // const result = ctx.waitUntil(render(renderOpts));
  stream.close();

  return response;
}
