import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import './PreferenceDialog.css';

interface PreferenceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialDefaultPath?: string;
  initialQuickAccessFolders?: string[];
  onSave: (newDefaultPath: string, newQuickAccessFolders: string[]) => void;
}

export default function PreferenceDialog({ isOpen, onClose, initialDefaultPath, initialQuickAccessFolders, onSave }: PreferenceDialogProps) {
  const [path, setPath] = useState(initialDefaultPath || '');
  const [quickAccess, setQuickAccess] = useState<string[]>(initialQuickAccessFolders || []);

  useEffect(() => {
    if (isOpen) {
      setPath(initialDefaultPath || '');
      setQuickAccess(initialQuickAccessFolders || []);
    }
  }, [isOpen, initialDefaultPath, initialQuickAccessFolders]);

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
        defaultPath: path,
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

  const handleRemoveQuickAccess = (folderToRemove: string) => {
    setQuickAccess(quickAccess.filter(f => f !== folderToRemove));
  };

  const handleSave = () => {
    onSave(path, quickAccess);
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
          
          <div className="preference-item" style={{ marginTop: '15px' }}>
            <label>Quick Access Folders</label>
            <div className="quick-access-container" style={{ border: '1px solid #ccc', padding: '5px', borderRadius: '4px', minHeight: '100px', maxHeight: '200px', overflowY: 'auto', backgroundColor: '#fff' }}>
              {quickAccess.length === 0 ? (
                <div style={{ color: '#888', textAlign: 'center', padding: '10px', fontSize: '0.9em' }}>폴더가 없습니다.</div>
              ) : (
                quickAccess.map((folder) => (
                  <div key={folder} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px', borderBottom: '1px solid #eee' }}>
                    <span style={{ fontSize: '0.9em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '10px' }} title={folder}>{folder}</span>
                    <button onClick={() => handleRemoveQuickAccess(folder)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'red', fontWeight: 'bold' }}>&times;</button>
                  </div>
                ))
              )}
            </div>
            <button onClick={handleAddQuickAccess} style={{ marginTop: '5px', width: '100%', padding: '6px', cursor: 'pointer' }}>Add Folder</button>
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
