import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

// 전역 캐시
const iconCache = new Map<string, string>();
const pendingCallbacks = new Map<string, Array<(icon: string) => void>>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let batchQueue: Array<{ key: string; path?: string; extension?: string; is_dir: boolean }> = [];

function flushBatch() {
  if (batchQueue.length === 0) return;
  const requests = [...batchQueue];
  batchQueue = [];
  batchTimer = null;

  invoke<Record<string, string>>('get_file_icons', { requests })
    .then((result) => {
      if (result) {
        Object.entries(result).forEach(([key, iconUrl]) => {
          iconCache.set(key, iconUrl);
          const cbs = pendingCallbacks.get(key);
          if (cbs) {
            cbs.forEach((cb) => cb(iconUrl));
            pendingCallbacks.delete(key);
          }
        });
      }
    })
    .catch((err) => {
      console.warn('Failed to load file icons:', err);
    });
}

function requestIcon(
  key: string,
  path: string | undefined,
  extension: string | undefined,
  is_dir: boolean,
  callback: (icon: string) => void
) {
  if (iconCache.has(key)) {
    callback(iconCache.get(key)!);
    return;
  }

  const existing = pendingCallbacks.get(key);
  if (existing) {
    existing.push(callback);
    return;
  }

  pendingCallbacks.set(key, [callback]);
  batchQueue.push({ key, path, extension, is_dir });

  if (!batchTimer) {
    batchTimer = setTimeout(flushBatch, 16);
  }
}

export interface FileIconProps {
  name: string;
  path?: string;
  isDirectory?: boolean;
  isLoading?: boolean;
  style?: React.CSSProperties;
}

export const FileIcon: React.FC<FileIconProps> = ({
  name,
  path,
  isDirectory = false,
  isLoading = false,
  style,
}) => {
  if (isLoading) {
    return <span style={{ marginRight: '8px', ...style }}>⏳</span>;
  }

  const ext = !isDirectory && name.includes('.') ? name.split('.').pop() || '' : '';
  const isSpecial = !isDirectory && (ext.toLowerCase() === 'exe' || ext.toLowerCase() === 'lnk' || ext.toLowerCase() === 'ico');
  const cacheKey = isDirectory ? '__dir__' : (isSpecial && path ? `file:${path.toLowerCase()}` : `ext:${ext.toLowerCase()}`);

  const [iconSrc, setIconSrc] = useState<string | null>(() => iconCache.get(cacheKey) || null);

  useEffect(() => {
    let mounted = true;
    requestIcon(cacheKey, path, ext, isDirectory, (icon) => {
      if (mounted) setIconSrc(icon);
    });
    return () => {
      mounted = false;
    };
  }, [cacheKey, path, ext, isDirectory]);

  if (iconSrc) {
    return (
      <img
        src={iconSrc}
        alt=""
        style={{
          width: 16,
          height: 16,
          marginRight: '8px',
          verticalAlign: 'middle',
          objectFit: 'contain',
          flexShrink: 0,
          ...style,
        }}
      />
    );
  }

  return <span style={{ marginRight: '8px', ...style }}>{isDirectory ? '📁' : '📄'}</span>;
};

export default FileIcon;
