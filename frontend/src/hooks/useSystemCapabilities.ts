import { useEffect, useState } from 'react';

import { defaultSystemCapabilities, systemCapabilitiesStore } from '../store/systemCapabilitiesStore';
import type { SystemCapabilities } from '../types/api';

/**
 * Server-published limits, replacing values the UI used to hardcode.
 * See docs/04-api-design.md (GET /system/capabilities).
 *
 * Starts from the defaults so a form can render before the request lands, then
 * re-renders once the real values arrive. The result is cached process-wide, so
 * several components mounting at once share one request.
 */
export function useSystemCapabilities(): SystemCapabilities {
  const [capabilities, setCapabilities] = useState<SystemCapabilities>(
    () => systemCapabilitiesStore.peek() ?? defaultSystemCapabilities,
  );

  useEffect(() => {
    let active = true;
    void systemCapabilitiesStore.load().then((loaded) => {
      if (active) setCapabilities(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  return capabilities;
}
