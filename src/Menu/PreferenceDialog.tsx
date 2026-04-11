import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import './PreferenceDialog.css';

interface PreferenceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialDefaultPath?: string;
  initialQuickAccessFolders?: string[];
  initialEditableFolders?: string[];
  initialReadonlyFolders?: string[];
  initialColumnSettings?: { key: string; visible: boolean }[];
  onSave: (newDefaultPath: string, newQuickAccess?: string[], newEditable?: string[], newReadonly?: string[], newColumnSettings?: { key: string; visible: boolean }[]) => void;
}

const DEFAULT_COLUMN_SETTINGS = [
  { key: 'name', visible: true },
  { key: 'size', visible: true },
  { key: 'type', visible: true },
  { key: 'birthtime', visible: true },
  { key: 'mtime', visible: true },
  { key: 'atime', visible: true },
  { key: 'path', visible: true },
];

export default function PreferenceDialog({ isOpen, onClose, initialDefaultPath, initialQuickAccessFolders, initialEditableFolders, initialReadonlyFolders, initialColumnSettings, onSave }: PreferenceDialogProps) {
  const [path, setPath] = useState(initialDefaultPath || '');
  const [quickAccess, setQuickAccess] = useState<string[]>(initialQuickAccessFolders || []);
  const [editable, setEditable] = useState<string[]>(initialEditableFolders || []);
  const [readonly, setReadonly] = useState<string[]>(initialReadonlyFolders || []);
  const [columnSettings, setColumnSettings] = useState<{ key: string; visible: boolean }[]>(initialColumnSettings && initialColumnSettings.length > 0 ? initialColumnSettings : DEFAULT_COLUMN_SETTINGS);

  // Helper to get basename from path
  const getBaseName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() || p;

  useEffect(() => {
    if (isOpen) {
      setPath(initialDefaultPath || '');
      setQuickAccess(initialQuickAccessFolders || []);
      setEditable(initialEditableFolders || []);
      setReadonly(initialReadonlyFolders || []);
      setColumnSettings(initialColumnSettings && initialColumnSettings.length > 0 ? initialColumnSettings : DEFAULT_COLUMN_SETTINGS);
    }
  }, [isOpen, initialDefaultPath, initialQuickAccessFolders, initialEditableFolders, initialReadonlyFolders, initialColumnSettings]);

  const handleBrowse = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '기본 폴더 선택',
        defaultPath: path,
      });
      if (selected && typeof selected === 'string') {
        setPath(selected);
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handleAddQuickAccess = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Quick Access 폴더 추가',
      });
      if (selected && typeof selected === 'string') {
        if (!quickAccess.includes(selected)) {
          setQuickAccess([...quickAccess, selected]);
        }
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handleRemoveQuickAccess = (folder: string) => {
    setQuickAccess(quickAccess.filter((f) => f !== folder));
  };

  const handleAddEditableFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: '편집 가능 폴더 추가' });
      if (selected && typeof selected === 'string') {
        if (!editable.includes(selected)) {
          setEditable(prev => [...prev, selected]);
          // Remove from readonly if present
          setReadonly(prev => prev.filter(p => p !== selected));
        }
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handleAddReadonlyFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: '읽기 전용 폴더 추가' });
      if (selected && typeof selected === 'string') {
        if (!readonly.includes(selected)) {
          setReadonly(prev => [...prev, selected]);
          // Remove from editable if present
          setEditable(prev => prev.filter(p => p !== selected));
        }
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handleRemoveFolderList = (folder: string, list: string[], setList: (l: string[]) => void) => {
    setList(list.filter((f) => f !== folder));
  };

  const handleSave = () => {
    // Ensure editable/readonly do not contain the same paths: editable takes precedence
    const finalEditable = Array.from(new Set(editable));
    const finalReadonly = Array.from(new Set(readonly.filter(r => !finalEditable.includes(r))));
    onSave(path, quickAccess, finalEditable, finalReadonly, columnSettings);
    onClose();
  };

  const handleMoveColumn = (index: number, direction: 'up' | 'down') => {
    const newSettings = [...columnSettings];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= newSettings.length) return;
    [newSettings[index], newSettings[targetIndex]] = [newSettings[targetIndex], newSettings[index]];
    setColumnSettings(newSettings);
  };

  const handleToggleColumn = (key: string) => {
    setColumnSettings(prev => prev.map(col => 
      col.key === key ? { ...col, visible: !col.visible } : col
    ));
  };

  if (!isOpen) return null;

  const columnLabels: Record<string, string> = {
    name: 'Name', size: 'Size', type: 'Type',
    birthtime: 'Date Created', mtime: 'Date Modified',
    atime: 'Date Accessed', path: 'Path'
  };

  const renderFolderList = (title: string, list: string[], onAdd: () => void, onRemove: (f: string) => void) => (
    <div className="preference-item">
      <div className="preference-label-group">
        <span className="label-text">{title}</span>
        <span className="preference-badge">{list.length}</span>
      </div>
      <div className="folder-card-list">
        {list.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8', fontSize: '0.85rem' }}>No folders added.</div>
        ) : (
          list.map((folder) => (
            <div key={folder} className="folder-card-item">
              <div className="folder-info">
                <span className="folder-name">📁 {getBaseName(folder)}</span>
                <span className="folder-path" title={folder}>{folder}</span>
              </div>
              <button className="btn-icon-delete" onClick={() => onRemove(folder)} title="Remove">🗑️</button>
            </div>
          ))
        )}
      </div>
      <button className="btn-add" onClick={onAdd}>+ Add Folder</button>
    </div>
  );

  return (
    <div className="preference-overlay">
      <div className="preference-modal">
        <div className="preference-header">
          <h3>Preferences</h3>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>
        <div className="preference-body">
          <div className="preference-item">
            <span className="label-text">Default Start Folder</span>
            <div className="input-group">
              <input type="text" value={path} readOnly />
              <button className="btn-secondary" onClick={handleBrowse} style={{ padding: '4px 12px' }}>Browse</button>
            </div>
          </div>

          {renderFolderList("Quick Access Folders", quickAccess, handleAddQuickAccess, handleRemoveQuickAccess)}
          {renderFolderList("Editable Folders (Allow)", editable, handleAddEditableFolder, (f) => handleRemoveFolderList(f, editable, setEditable))}
          {renderFolderList("Read-only Folders (Deny)", readonly, handleAddReadonlyFolder, (f) => handleRemoveFolderList(f, readonly, setReadonly))}

          <div className="preference-item">
            <span className="label-text">File List Columns (Visibility & Order)</span>
            <div className="column-settings-list" style={{ marginTop: '10px', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
              {columnSettings.map((col, index) => (
                <div key={col.key} style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: index === columnSettings.length - 1 ? 'none' : '1px solid #f1f5f9' }}>
                  <input 
                    type="checkbox" 
                    checked={col.visible} 
                    onChange={() => handleToggleColumn(col.key)}
                    style={{ marginRight: '12px' }}
                  />
                  <span style={{ flex: 1, fontSize: '0.9rem' }}>{columnLabels[col.key]}</span>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button className="btn-mini" onClick={() => handleMoveColumn(index, 'up')} disabled={index === 0}>▲</button>
                    <button className="btn-mini" onClick={() => handleMoveColumn(index, 'down')} disabled={index === columnSettings.length - 1}>▼</button>
                  </div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '6px' }}>
              Check to show columns. Use arrows to reorder them from left to right.
            </p>
          </div>
        </div>
        <div className="preference-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>Save Changes</button>
        </div>
      </div>
    </div>
  );
}