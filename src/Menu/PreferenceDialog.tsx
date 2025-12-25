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
  onSave: (newDefaultPath: string, newQuickAccess?: string[], newEditable?: string[], newReadonly?: string[]) => void;
}

export default function PreferenceDialog({ isOpen, onClose, initialDefaultPath, initialQuickAccessFolders, initialEditableFolders, initialReadonlyFolders, onSave }: PreferenceDialogProps) {
  const [path, setPath] = useState(initialDefaultPath || '');
  const [quickAccess, setQuickAccess] = useState<string[]>(initialQuickAccessFolders || []);
  const [editable, setEditable] = useState<string[]>(initialEditableFolders || []);
  const [readonly, setReadonly] = useState<string[]>(initialReadonlyFolders || []);

  useEffect(() => {
    if (isOpen) {
      setPath(initialDefaultPath || '');
      setQuickAccess(initialQuickAccessFolders || []);
      setEditable(initialEditableFolders || []);
      setReadonly(initialReadonlyFolders || []);
    }
  }, [isOpen, initialDefaultPath, initialQuickAccessFolders, initialEditableFolders, initialReadonlyFolders]);

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

  const handleAddFolderList = async (list: string[], setList: (l: string[]) => void, title: string) => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: title,
      });
      if (selected && typeof selected === 'string') {
        if (!list.includes(selected)) {
          setList([...list, selected]);
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
    onSave(path, quickAccess, editable, readonly);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="preference-overlay">
      <div className="preference-modal">
        <div className="preference-header">
          <h3>Preferences</h3>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>
        <div className="preference-body">
          <div className="preference-item">
            <label>Default Folder</label>
            <div className="input-group">
              <input type="text" value={path} readOnly />
              <button onClick={handleBrowse}>Browse</button>
            </div>
          </div>
          <div className="preference-item">
            <label>Quick Access Folders</label>
            <div className="quick-access-list" style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid #ccc', marginBottom: '10px' }}>
              {quickAccess.map((folder) => (
                <div key={folder} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px', borderBottom: '1px solid #eee' }}>
                  <span style={{ fontSize: '0.9em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '10px' }} title={folder}>{folder}</span>
                  <button onClick={() => handleRemoveQuickAccess(folder)} style={{ cursor: 'pointer' }}>&times;</button>
                </div>
              ))}
            </div>
            <button onClick={handleAddQuickAccess}>Add Folder</button>
          </div>
          <div className="preference-item">
            <label>Editable Folders (Allow)</label>
            <div className="quick-access-list" style={{ maxHeight: '100px', overflowY: 'auto', border: '1px solid #ccc', marginBottom: '10px' }}>
              {editable.map((folder) => (
                <div key={folder} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px', borderBottom: '1px solid #eee' }}>
                  <span style={{ fontSize: '0.9em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '10px' }} title={folder}>{folder}</span>
                  <button onClick={() => handleRemoveFolderList(folder, editable, setEditable)} style={{ cursor: 'pointer' }}>&times;</button>
                </div>
              ))}
            </div>
            <button onClick={() => handleAddFolderList(editable, setEditable, '편집 가능 폴더 추가')}>Add Editable Folder</button>
          </div>
          <div className="preference-item">
            <label>Read-only Folders (Deny)</label>
            <div className="quick-access-list" style={{ maxHeight: '100px', overflowY: 'auto', border: '1px solid #ccc', marginBottom: '10px' }}>
              {readonly.map((folder) => (
                <div key={folder} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px', borderBottom: '1px solid #eee' }}>
                  <span style={{ fontSize: '0.9em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '10px' }} title={folder}>{folder}</span>
                  <button onClick={() => handleRemoveFolderList(folder, readonly, setReadonly)} style={{ cursor: 'pointer' }}>&times;</button>
                </div>
              ))}
            </div>
            <button onClick={() => handleAddFolderList(readonly, setReadonly, '읽기 전용 폴더 추가')}>Add Read-only Folder</button>
          </div>
        </div>
        <div className="preference-footer">
          <button onClick={handleSave}>Save</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}