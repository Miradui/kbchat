import { UserRound } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { apiBlobRequest } from '../api/client';
import { tokenStore } from '../store/tokenStore';
import { managedAvatarPath } from '../utils/avatar';

type Props = { url?: string; name?: string; label?: string; className?: string };

export function UserAvatar({ url = '', name = '', label, className = '' }: Props) {
  const authRevision = useSyncExternalStore(tokenStore.subscribe, tokenStore.getRevision);
  const [loaded, setLoaded] = useState<{ url: string; revision: number; objectURL: string } | null>(null);
  const [failedURL, setFailedURL] = useState('');
  const path = managedAvatarPath(url);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let active = true;
    let objectURL = '';
    void apiBlobRequest(path, { signal: controller.signal }).then(blob => {
      if (!active || tokenStore.getRevision() !== authRevision || (blob.type && blob.type !== 'image/png')) return;
      objectURL = URL.createObjectURL(blob);
      setLoaded({ url, revision: authRevision, objectURL });
    }).catch(() => { /* Keep the initial when a thumbnail is unavailable. */ });
    return () => {
      active = false;
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [path, url, authRevision]);

  const source = path
    ? loaded?.url === url && loaded.revision === authRevision ? loaded.objectURL : ''
    : /^(https?:\/\/|\/(?!\/))/i.test(url) ? url : '';
  const initial = Array.from(name.trim())[0];
  return (
    <span className={`ui-avatar ${className}`.trim()} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {source && source !== failedURL
        ? <img alt="" src={source} onError={() => setFailedURL(source)} />
        : initial || <UserRound size={13} />}
    </span>
  );
}
