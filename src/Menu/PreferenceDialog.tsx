import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
  initialLanguage?: string;
  initialUsePdfWorker?: boolean;
  initialLicenseEmail?: string;
  initialLicenseCode?: string;
  licenseInfo?: any;
  onActivateLicense?: (email: string, code: string) => Promise<void>;
  onSave: (newDefaultPath: string, newQuickAccess?: string[], newEditable?: string[], newReadonly?: string[], newColumnSettings?: { key: string; visible: boolean }[], newLanguage?: string, newUsePdfWorker?: boolean, newLicenseEmail?: string, newLicenseCode?: string) => void;
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

export default function PreferenceDialog({ isOpen, onClose, initialDefaultPath, initialQuickAccessFolders, initialEditableFolders, initialReadonlyFolders, initialColumnSettings, initialLanguage, initialUsePdfWorker, initialLicenseEmail, initialLicenseCode, licenseInfo, onActivateLicense, onSave }: PreferenceDialogProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'General' | 'Folder' | 'License'>('General');
  const [path, setPath] = useState(initialDefaultPath || '');
  const [quickAccess, setQuickAccess] = useState<string[]>(initialQuickAccessFolders || []);
  const [editable, setEditable] = useState<string[]>(initialEditableFolders || []);
  const [readonly, setReadonly] = useState<string[]>(initialReadonlyFolders || []);
  const [columnSettings, setColumnSettings] = useState<{ key: string; visible: boolean }[]>(initialColumnSettings && initialColumnSettings.length > 0 ? initialColumnSettings : DEFAULT_COLUMN_SETTINGS);
  const [language, setLanguage] = useState<string>(initialLanguage || 'en');
  const [usePdfWorker, setUsePdfWorker] = useState<boolean>(initialUsePdfWorker !== false);
  const [licenseEmail, setLicenseEmail] = useState<string>(initialLicenseEmail || '');
  const [licenseCode, setLicenseCode] = useState<string>(initialLicenseCode || '');

  // Helper to get basename from path
  const getBaseName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() || p;

  useEffect(() => {
    if (isOpen) {
      setActiveTab('General');
      setPath(initialDefaultPath || '');
      setQuickAccess(initialQuickAccessFolders || []);
      setEditable(initialEditableFolders || []);
      setReadonly(initialReadonlyFolders || []);
      setColumnSettings(initialColumnSettings && initialColumnSettings.length > 0 ? initialColumnSettings : DEFAULT_COLUMN_SETTINGS);
      setLanguage(initialLanguage || 'en');
      setUsePdfWorker(initialUsePdfWorker !== false);
      setLicenseEmail(initialLicenseEmail || '');
      setLicenseCode(initialLicenseCode || '');
    }
  }, [isOpen, initialDefaultPath, initialQuickAccessFolders, initialEditableFolders, initialReadonlyFolders, initialColumnSettings, initialLanguage, initialUsePdfWorker, initialLicenseEmail, initialLicenseCode]);

  const handleBrowse = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('preferences.defaultStartFolder'),
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
        title: t('preferences.quickAccessFolders'),
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
      const selected = await open({ directory: true, multiple: false, title: t('preferences.editableFolders') });
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
      const selected = await open({ directory: true, multiple: false, title: t('preferences.readonlyFolders') });
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
    onSave(path, quickAccess, finalEditable, finalReadonly, columnSettings, language, usePdfWorker, licenseEmail, licenseCode);
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
    name: t('columns.name'), size: t('columns.size'), type: t('columns.type'),
    birthtime: t('columns.birthtime'), mtime: t('columns.mtime'),
    atime: t('columns.atime'), path: t('columns.path')
  };

  const renderFolderList = (title: string, list: string[], onAdd: () => void, onRemove: (f: string) => void) => (
    <div className="preference-item">
      <div className="preference-label-group">
        <span className="label-text">{title}</span>
        <span className="preference-badge">{list.length}</span>
      </div>
      <div className="folder-card-list">
        {list.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8', fontSize: '0.85rem' }}>{t('preferences.noFoldersAdded')}</div>
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
      <button className="btn-add" onClick={onAdd}>{t('preferences.addFolder')}</button>
    </div>
  );

  return (
    <div className="preference-overlay">
      <div className="preference-modal">
        <div className="preference-header">
          <h3>{t('preferences.title')}</h3>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>
        <div className="preference-tabs">
          <button 
            className={`preference-tab ${activeTab === 'General' ? 'active' : ''}`}
            onClick={() => setActiveTab('General')}
          >
            {t('preferences.general')}
          </button>
          <button 
            className={`preference-tab ${activeTab === 'Folder' ? 'active' : ''}`}
            onClick={() => setActiveTab('Folder')}
          >
            {t('preferences.folder')}
          </button>
          <button 
            className={`preference-tab ${activeTab === 'License' ? 'active' : ''}`}
            onClick={() => setActiveTab('License')}
          >
            {t('preferences.license')}
          </button>
        </div>
        <div className="preference-body">
          {activeTab === 'General' && (
            <>
              <div className="preference-item">
                <span className="label-text">{t('preferences.language')}</span>
                <div className="input-group">
                  <select 
                    value={language} 
                    onChange={(e) => setLanguage(e.target.value)}
                    style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', color: '#64748b', fontSize: '0.9rem' }}
                  >
                    <option value="ar">{t('preferences.lang_ar')}</option>
                    <option value="de-AT">{t('preferences.lang_de_AT')}</option>
                    <option value="bn">{t('preferences.lang_bn')}</option>
                    <option value="my">{t('preferences.lang_my')}</option>
                    <option value="km">{t('preferences.lang_km')}</option>
                    <option value="yue">{t('preferences.lang_yue')}</option>
                    <option value="zh">{t('preferences.lang_zh')}</option>
                    <option value="cs">{t('preferences.lang_cs')}</option>
                    <option value="en">{t('preferences.lang_en')}</option>
                    <option value="fr">{t('preferences.lang_fr')}</option>
                    <option value="de">{t('preferences.lang_de')}</option>
                    <option value="el">{t('preferences.lang_el')}</option>
                    <option value="id">{t('preferences.lang_id')}</option>
                    <option value="it">{t('preferences.lang_it')}</option>
                    <option value="ja">{t('preferences.lang_ja')}</option>
                    <option value="ko">{t('preferences.lang_ko')}</option>
                    <option value="lo">{t('preferences.lang_lo')}</option>
                    <option value="ms">{t('preferences.lang_ms')}</option>
                    <option value="mn">{t('preferences.lang_mn')}</option>
                    <option value="pl">{t('preferences.lang_pl')}</option>
                    <option value="ru">{t('preferences.lang_ru')}</option>
                    <option value="es">{t('preferences.lang_es')}</option>
                    <option value="zh-TW">{t('preferences.lang_zh_TW')}</option>
                    <option value="th">{t('preferences.lang_th')}</option>
                    <option value="tr">{t('preferences.lang_tr')}</option>
                    <option value="vi">{t('preferences.lang_vi')}</option>
                  </select>
                </div>
              </div>
              <div className="preference-item" style={{ flexDirection: 'row', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
                <input 
                  type="checkbox" 
                  id="pdfWorkerCheckbox"
                  checked={usePdfWorker}
                  onChange={(e) => setUsePdfWorker(e.target.checked)}
                  style={{ width: '16px', height: '16px', margin: 0, cursor: 'pointer' }}
                />
                <label htmlFor="pdfWorkerCheckbox" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', margin: 0, flex: 1 }}>
                  <span style={{ fontSize: '0.95rem', fontWeight: 600, color: '#334155' }}>{t('preferences.usePdfWorker', 'Use Built-in PDF Viewer')}</span>
                  <span style={{ fontSize: '0.85rem', color: '#64748b' }}>- {t('preferences.usePdfWorkerDesc', 'Open PDF files with internal PDF worker by default')}</span>
                </label>
              </div>
              <div className="preference-item">
                <span className="label-text">{t('preferences.columnsTitle')}</span>
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
                  {t('preferences.columnsDesc')}
                </p>
              </div>
            </>
          )}

          {activeTab === 'Folder' && (
            <>
              <div className="preference-item">
                <span className="label-text">{t('preferences.defaultStartFolder')}</span>
                <div className="input-group">
                  <input type="text" value={path} readOnly />
                  <button className="btn-secondary" onClick={handleBrowse} style={{ padding: '4px 12px' }}>{t('preferences.browse')}</button>
                </div>
              </div>

              {renderFolderList(t('preferences.quickAccessFolders'), quickAccess, handleAddQuickAccess, handleRemoveQuickAccess)}
              {renderFolderList(t('preferences.editableFolders'), editable, handleAddEditableFolder, (f) => handleRemoveFolderList(f, editable, setEditable))}
              {renderFolderList(t('preferences.readonlyFolders'), readonly, handleAddReadonlyFolder, (f) => handleRemoveFolderList(f, readonly, setReadonly))}
            </>
          )}

          {activeTab === 'License' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '10px 0' }}>
              <div className="preference-item" style={{ backgroundColor: '#f1f5f9', padding: '12px', borderRadius: '8px' }}>
                <span className="label-text">License Status</span>
                <div style={{ marginTop: '8px', fontSize: '0.95rem', fontWeight: 600 }}>
                  {licenseInfo?.status === 'Expired' && <span style={{ color: '#ef4444' }}>Expired</span>}
                  {typeof licenseInfo?.status === 'object' && 'Trial' in licenseInfo.status && <span style={{ color: '#eab308' }}>Trial Mode ({licenseInfo.status.Trial.days_left} days left)</span>}
                  {typeof licenseInfo?.status === 'object' && 'Activated' in licenseInfo.status && <span style={{ color: '#22c55e' }}>Activated (Expires: {new Date(licenseInfo.status.Activated.expiry_date * 1000).toLocaleDateString()})</span>}
                </div>
              </div>

              <div className="preference-item">
                <span className="label-text">Device ID</span>
                <div className="input-group">
                  <input type="text" value={licenseInfo?.device_id || ''} readOnly style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', fontSize: '0.9rem', fontFamily: 'monospace' }} />
                  <button className="btn-secondary" onClick={() => navigator.clipboard.writeText(licenseInfo?.device_id || '')}>Copy</button>
                </div>
                <p style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '4px' }}>
                  This unique ID is generated based on your hardware and will be sent to the license server to bind your license.
                </p>
              </div>

              <div className="preference-item">
                <span className="label-text">{t('preferences.email', 'Email Address')}</span>
                <div className="input-group">
                  <input type="email" value={licenseEmail} onChange={(e) => setLicenseEmail(e.target.value)} placeholder="name@example.com" style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', fontSize: '0.9rem' }} />
                  <button 
                    className="btn-primary" 
                    onClick={() => {
                       if (!licenseEmail) { alert('Please enter your email first.'); return; }
                       if (window.confirm(`Your Device ID (${licenseInfo?.device_id}) and Email will be sent to the purchase page. Continue?`)) {
                           import('@tauri-apps/plugin-shell').then(({ open }) => {
                               open(`https://www.marh-sw.com/?email=${encodeURIComponent(licenseEmail)}&deviceId=${encodeURIComponent(licenseInfo?.device_id || '')}`);
                           });
                       }
                    }}
                  >Buy License</button>
                </div>
              </div>
              <div className="preference-item">
                <span className="label-text">{t('preferences.licenseCode', 'License Code')}</span>
                <div className="input-group">
                  <input type="text" value={licenseCode} onChange={(e) => setLicenseCode(e.target.value)} placeholder="Enter license code" style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', fontSize: '0.9rem', fontFamily: 'monospace' }} />
                  <button className="btn-primary" onClick={() => onActivateLicense?.(licenseEmail, licenseCode)}>Activate</button>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="preference-footer">
          <button className="btn-secondary" onClick={onClose}>{t('preferences.cancel')}</button>
          <button className="btn-primary" onClick={handleSave}>{t('preferences.saveChanges')}</button>
        </div>
      </div>
    </div>
  );
}