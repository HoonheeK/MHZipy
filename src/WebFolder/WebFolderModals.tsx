import React, { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';

export type WebFolderSafetyLevel = 'download_only' | 'caution' | 'strict';

export interface WebFolderItem {
  id: string;
  name: string;
  url: string;
  linkedLocalPath: string;
  safetyLevel: WebFolderSafetyLevel;
  createdAt: number;
}

interface WebFolderEditModalProps {
  open: boolean;
  initialItem?: WebFolderItem | null;
  defaultLocalPath?: string;
  onClose: () => void;
  onSave: (item: WebFolderItem) => void;
}

export const WebFolderEditModal: React.FC<WebFolderEditModalProps> = ({
  open: isOpen,
  initialItem,
  defaultLocalPath = '',
  onClose,
  onSave,
}) => {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [linkedLocalPath, setLinkedLocalPath] = useState('');
  const [safetyLevel, setSafetyLevel] = useState<WebFolderSafetyLevel>('caution');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (isOpen) {
      if (initialItem) {
        setName(initialItem.name);
        setUrl(initialItem.url);
        setLinkedLocalPath(initialItem.linkedLocalPath || '');
        setSafetyLevel(initialItem.safetyLevel || 'caution');
      } else {
        setName('');
        setUrl('https://app.box.com/folder/');
        setLinkedLocalPath(defaultLocalPath);
        setSafetyLevel('caution');
      }
      setErrorMsg('');
    }
  }, [isOpen, initialItem, defaultLocalPath]);

  if (!isOpen) return null;

  const handleBrowseLocal = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: linkedLocalPath || undefined,
    });
    if (selected && typeof selected === 'string') {
      setLinkedLocalPath(selected);
      if (!name.trim()) {
        const folderName = selected.split(/[/\\]/).filter(Boolean).pop();
        if (folderName) setName(`Box - ${folderName}`);
      }
    }
  };

  const handleSubmit = () => {
    const cleanName = name.trim();
    const cleanUrl = url.trim();
    if (!cleanName) {
      setErrorMsg('Please enter a name for the web folder.');
      return;
    }
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      setErrorMsg('URL must start with https:// or http:// (e.g. https://app.box.com/...)');
      return;
    }
    onSave({
      id: initialItem?.id || `wf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: cleanName,
      url: cleanUrl,
      linkedLocalPath: linkedLocalPath.trim(),
      safetyLevel,
      createdAt: initialItem?.createdAt || Date.now(),
    });
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(2, 6, 23, 0.72)',
        backdropFilter: 'blur(3px)',
        zIndex: 3000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          backgroundColor: '#0f172a',
          border: '1px solid rgba(255, 255, 255, 0.16)',
          borderRadius: '10px',
          width: '100%',
          maxWidth: '500px',
          boxShadow: '0 20px 45px rgba(0, 0, 0, 0.65)',
          color: '#f8fafc',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            backgroundColor: '#1e293b',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, fontSize: '0.96em' }}>
            <span>🌐</span>
            <span>{initialItem ? 'Edit Web Folder (Box / Cloud)' : 'Add Web Folder (Box / Cloud)'}</span>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '1.1em' }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '13px', fontSize: '0.88em' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label style={{ fontWeight: 600, color: '#cbd5e1' }}>Web Folder Name:</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Box - Project Alpha Shared"
              autoFocus
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(255, 255, 255, 0.16)',
                backgroundColor: '#1e293b',
                color: '#f8fafc',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label style={{ fontWeight: 600, color: '#cbd5e1' }}>Web Folder URL (Box, SharePoint, Google Drive, etc.):</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://app.box.com/folder/..."
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(255, 255, 255, 0.16)',
                backgroundColor: '#1e293b',
                color: '#38bdf8',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label style={{ fontWeight: 600, color: '#cbd5e1' }}>
              Linked Local Folder <span style={{ fontWeight: 400, color: '#94a3b8' }}>(Auto-creates Web Folder Hierarchy on Download)</span>:
            </label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type="text"
                value={linkedLocalPath}
                onChange={(e) => setLinkedLocalPath(e.target.value)}
                placeholder="e.g. D:\Work\ProjectAlpha"
                style={{
                  flex: 1,
                  padding: '8px 10px',
                  borderRadius: '6px',
                  border: '1px solid rgba(255, 255, 255, 0.16)',
                  backgroundColor: '#1e293b',
                  color: '#f8fafc',
                  outline: 'none',
                }}
              />
              <button
                type="button"
                onClick={handleBrowseLocal}
                style={{
                  padding: '0 12px',
                  borderRadius: '6px',
                  border: '1px solid rgba(255, 255, 255, 0.16)',
                  backgroundColor: '#334155',
                  color: '#f8fafc',
                  cursor: 'pointer',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                📁 Browse...
              </button>
            </div>
            <div style={{ fontSize: '0.82em', color: '#94a3b8', lineHeight: 1.35 }}>
              When downloading files or folders inside the Web Folder window, MHZipy automatically mirrors the web folder&apos;s subfolder hierarchy inside this local folder and unpacks folder ZIPs into place.
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontWeight: 600, color: '#cbd5e1' }}>Upload Safety Level (Prevents Accidental Uploads):</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '8px',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  backgroundColor: safetyLevel === 'download_only' ? 'rgba(16, 185, 129, 0.15)' : '#1e293b',
                  border: safetyLevel === 'download_only' ? '1px solid #10b981' : '1px solid rgba(255,255,255,0.08)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="wf-safety"
                  checked={safetyLevel === 'download_only'}
                  onChange={() => setSafetyLevel('download_only')}
                  style={{ marginTop: '3px' }}
                />
                <div>
                  <div style={{ fontWeight: 700, color: '#34d399' }}>🟢 Download Only (Read-Only)</div>
                  <div style={{ fontSize: '0.84em', color: '#94a3b8' }}>
                    Permanently blocks all file uploads (Drag &amp; Drop, Paste, File Dialog). Safe for reference folders.
                  </div>
                </div>
              </label>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '8px',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  backgroundColor: safetyLevel === 'caution' ? 'rgba(245, 158, 11, 0.15)' : '#1e293b',
                  border: safetyLevel === 'caution' ? '1px solid #f59e0b' : '1px solid rgba(255,255,255,0.08)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="wf-safety"
                  checked={safetyLevel === 'caution'}
                  onChange={() => setSafetyLevel('caution')}
                  style={{ marginTop: '3px' }}
                />
                <div>
                  <div style={{ fontWeight: 700, color: '#fbbf24' }}>🟡 Standard Caution (Recommended)</div>
                  <div style={{ fontSize: '0.84em', color: '#94a3b8' }}>
                    Starts with Upload Locked (🔒). Requires Pre-Upload File Inspection &amp; Checklist to unlock for 5 minutes.
                  </div>
                </div>
              </label>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '8px',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  backgroundColor: safetyLevel === 'strict' ? 'rgba(239, 68, 68, 0.15)' : '#1e293b',
                  border: safetyLevel === 'strict' ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.08)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="wf-safety"
                  checked={safetyLevel === 'strict'}
                  onChange={() => setSafetyLevel('strict')}
                  style={{ marginTop: '3px' }}
                />
                <div>
                  <div style={{ fontWeight: 700, color: '#f87171' }}>🔴 Strict Official / Client Shared Folder</div>
                  <div style={{ fontSize: '0.84em', color: '#94a3b8' }}>
                    Displays high-alert warning banner, blocks accidental drops, and enforces strict file name &amp; version verification.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {errorMsg && (
            <div style={{ color: '#f87171', fontSize: '0.86em', fontWeight: 600 }}>⚠️ {errorMsg}</div>
          )}
        </div>

        <div
          style={{
            padding: '10px 16px',
            backgroundColor: '#131d2e',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              backgroundColor: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid rgba(255, 255, 255, 0.14)',
              color: '#cbd5e1',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            style={{
              padding: '6px 16px',
              borderRadius: '6px',
              backgroundColor: '#2563eb',
              border: '1px solid #3b82f6',
              color: '#ffffff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Save Web Folder
          </button>
        </div>
      </div>
    </div>
  );
};


