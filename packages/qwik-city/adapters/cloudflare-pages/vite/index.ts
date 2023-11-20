import type { StaticGenerateRenderOptions } from '@builder.io/qwik-city/static';
import { type ServerAdapterOptions, viteAdapter } from '../../shared/vite';
import fs from 'node:fs';
import { join, relative } from 'node:path';
import { normalizePathSlash } from '../../../utils/fs';
import type { QwikViteDevResponse } from '@builder.io/qwik/optimizer';
import type { Connect } from 'vite';
import { Miniflare, type WorkerOptions } from 'miniflare';

/** @public */
export async function cloudflarePagesAdapter(
  opts: CloudflarePagesAdapterOptions = {}
): Promise<any> {
  const env = process?.env;
  return viteAdapter({
    name: 'cloudflare-pages',
    origin: env?.CF_PAGES_URL ?? env?.ORIGIN ?? 'https://your.cloudflare.pages.dev',
    ssg: opts.ssg,
    staticPaths: opts.staticPaths,
    cleanStaticGenerated: true,

    config() {
      return {
        resolve: {
          conditions: ['webworker', 'worker'],
        },
        ssr: {
          target: 'webworker',
          noExternal: true,
        },
        build: {
          ssr: true,
          rollupOptions: {
            output: {
              format: 'es',
              hoistTransitiveImports: false,
            },
          },
        },
        publicDir: false,
      };
    },

    async generate({ clientOutDir, serverOutDir, basePathname }) {
      const routesJsonPath = join(clientOutDir, '_routes.json');
      const hasRoutesJson = fs.existsSync(routesJsonPath);
      if (!hasRoutesJson && opts.functionRoutes !== false) {
        const routesJson = {
          version: 1,
          include: [basePathname + '*'],
          exclude: [basePathname + 'build/*', basePathname + 'assets/*'],
        };
        await fs.promises.writeFile(routesJsonPath, JSON.stringify(routesJson, undefined, 2));
      }
      // https://developers.cloudflare.com/pages/platform/functions/advanced-mode/
      const workerJsPath = join(clientOutDir, '_worker.js');
      const hasWorkerJs = fs.existsSync(workerJsPath);
      if (!hasWorkerJs) {
        const importPath = relative(clientOutDir, join(serverOutDir, 'entry.cloudflare-pages'));
        await fs.promises.writeFile(
          workerJsPath,
          `import { fetch } from "${normalizePathSlash(importPath)}"; export default { fetch };`
        );
      }
    },
    middlewares: await getCloudflarePagesMiddlewares(opts),
  });
}

async function getCloudflarePagesMiddlewares(
  opts: CloudflarePagesAdapterOptions
): Promise<Connect.NextHandleFunction[]> {
  // Note: this function is currently just a simplifies POC version of the final one
  //       what it needs to do is simply: collect the bindings from opts, instantiate miniflare, get the bindings
  //       from miniflare and set the in the middleware

  const kvNamespaces = opts.kvNamespaces;

  const workers: WorkerOptions[] = [
    {
      kvNamespaces,
      modules: true,
      script: '',
    },
  ];

  const mf = new Miniflare({
    workers,
  });

  const bindings = await mf.getBindings();

  return [
    (_req, res, next) => {
      (res as QwikViteDevResponse)._qwikEnvData = {
        ...(res as QwikViteDevResponse)._qwikEnvData,
        devPlatform: { env: bindings },
      };
      next();
    },
  ];
}

/** @public */
export interface CloudflarePagesAdapterOptions extends ServerAdapterOptions {
  /**
   * Determines if the build should generate the function invocation routes `_routes.json` file.
   *
   * https://developers.cloudflare.com/pages/platform/functions/routing/#functions-invocation-routes
   *
   * Defaults to `true`.
   */
  functionRoutes?: boolean;
  /**
   * Manually add pathnames that should be treated as static paths and not SSR. For example, when
   * these pathnames are requested, their response should come from a static file, rather than a
   * server-side rendered response.
   */
  staticPaths?: string[];

  // temporary POC option
  kvNamespaces?: string[];
}

/** @public */
export type { StaticGenerateRenderOptions };
