import type { QwikManifest } from '../types';
import { serializeRequestEv } from '../../../../../workerd-integration';

export { getWorkerdFunctions } from '../../../../../workerd-integration';

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
      ev: serializeRequestEv(ev),
    },
    containerAttributes: {
      ...serverData.containerAttributes,
    },
  };
  const serializedRenderOpts = JSON.parse(JSON.stringify(renderOpts));
  return serializedRenderOpts;
}
