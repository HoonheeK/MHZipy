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
  initialUseImageViewer?: boolean;
  initialUseVideoPlayer?: boolean;
  initialLicenseEmail?: string;
  initialLicenseCode?: string;
  initialDisableUpdateCheck?: boolean;
  initialPdfExportPath?: string;
  licenseInfo?: any;
  onActivateLicense?: (email: string, code: string) => Promise<void>;
  onSave: (newDefaultPath: string, newQuickAccess?: string[], newEditable?: string[], newReadonly?: string[], newColumnSettings?: { key: string; visible: boolean }[], newLanguage?: string, newUsePdfWorker?: boolean, newLicenseEmail?: string, newLicenseCode?: string, newDisableUpdateCheck?: boolean, newPdfExportPath?: string, newUseImageViewer?: boolean, newUseVideoPlayer?: boolean) => void;
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

export default function PreferenceDialog({ isOpen, onClose, initialDefaultPath, initialQuickAccessFolders, initialEditableFolders, initialReadonlyFolders, initialColumnSettings, initialLanguage, initialUsePdfWorker, initialUseImageViewer, initialUseVideoPlayer, initialLicenseEmail, initialLicenseCode, initialDisableUpdateCheck, initialPdfExportPath, licenseInfo: _licenseInfo, onActivateLicense: _onActivateLicense, onSave }: PreferenceDialogProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'General' | 'Folder'>('General');
  const [path, setPath] = useState(initialDefaultPath || '');
  const [quickAccess, setQuickAccess] = useState<string[]>(initialQuickAccessFolders || []);
  const [editable, setEditable] = useState<string[]>(initialEditableFolders || []);
  const [readonly, setReadonly] = useState<string[]>(initialReadonlyFolders || []);
  const [columnSettings, setColumnSettings] = useState<{ key: string; visible: boolean }[]>(initialColumnSettings && initialColumnSettings.length > 0 ? initialColumnSettings : DEFAULT_COLUMN_SETTINGS);
  const [language, setLanguage] = useState<string>(initialLanguage || 'en');
  const [usePdfWorker, setUsePdfWorker] = useState<boolean>(initialUsePdfWorker !== false);
  const [useImageViewer, setUseImageViewer] = useState<boolean>(initialUseImageViewer !== false);
  const [useVideoPlayer, setUseVideoPlayer] = useState<boolean>(initialUseVideoPlayer !== false);
  const [licenseEmail, setLicenseEmail] = useState<string>(initialLicenseEmail || '');
  const [licenseCode, setLicenseCode] = useState<string>(initialLicenseCode || '');
  const [disableUpdateCheck, setDisableUpdateCheck] = useState<boolean>(!!initialDisableUpdateCheck);
  const [pdfExportPath, setPdfExportPath] = useState<string>(initialPdfExportPath || '');

  // Dragging state
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Helper to get basename from path
  const getBaseName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() || p;

  const [alertMessage, setAlertMessage] = useState<{title: string, message: string} | null>(null);
  const [confirmAction, setConfirmAction] = useState<{title: string, message: string, onConfirm: () => void} | null>(null);

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
      setUseImageViewer(initialUseImageViewer !== false);
      setUseVideoPlayer(initialUseVideoPlayer !== false);
      setLicenseEmail(initialLicenseEmail || '');
      setLicenseCode(initialLicenseCode || '');
      setDisableUpdateCheck(!!initialDisableUpdateCheck);
      setPdfExportPath(initialPdfExportPath || '');
      setPosition({ x: 0, y: 0 });
    }
  }, [isOpen, initialDefaultPath, initialQuickAccessFolders, initialEditableFolders, initialReadonlyFolders, initialColumnSettings, initialLanguage, initialUsePdfWorker, initialUseImageViewer, initialUseVideoPlayer, initialLicenseEmail, initialLicenseCode, initialDisableUpdateCheck, initialPdfExportPath]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        setPosition({
          x: e.clientX - dragStart.x,
          y: e.clientY - dragStart.y
        });
      }
    };
    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragStart]);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // Prevent dragging if clicking on the close button
    if ((e.target as HTMLElement).tagName.toLowerCase() === 'button') {
      return;
    }
    setIsDragging(true);
    setDragStart({
      x: e.clientX - position.x,
      y: e.clientY - position.y
    });
  };

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
    onSave(path, quickAccess, finalEditable, finalReadonly, columnSettings, language, usePdfWorker, licenseEmail, licenseCode, disableUpdateCheck, pdfExportPath, useImageViewer, useVideoPlayer);
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
      <div
        className="preference-modal"
        style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
      >
        <div
          className="preference-header"
          onMouseDown={handleMouseDown}
          style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        >
          <h3 style={{ pointerEvents: 'none' }}>{t('preferences.title')}</h3>
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
                    style={{ flex: 1, padding: '8px 12px', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.12)', backgroundColor: '#1e293b', color: '#f8fafc', fontSize: '0.9rem', outline: 'none' }}
                  >
                    <option value="ar" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_ar')}</option>
                    <option value="de-AT" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_de_AT')}</option>
                    <option value="bn" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_bn')}</option>
                    <option value="my" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_my')}</option>
                    <option value="km" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_km')}</option>
                    <option value="yue" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_yue')}</option>
                    <option value="zh" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_zh')}</option>
                    <option value="cs" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_cs')}</option>
                    <option value="en" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_en')}</option>
                    <option value="fr" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_fr')}</option>
                    <option value="de" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_de')}</option>
                    <option value="el" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_el')}</option>
                    <option value="id" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_id')}</option>
                    <option value="it" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_it')}</option>
                    <option value="ja" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_ja')}</option>
                    <option value="ko" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_ko')}</option>
                    <option value="lo" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_lo')}</option>
                    <option value="ms" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_ms')}</option>
                    <option value="mn" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_mn')}</option>
                    <option value="pl" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_pl')}</option>
                    <option value="ru" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_ru')}</option>
                    <option value="es" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_es')}</option>
                    <option value="zh-TW" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_zh_TW')}</option>
                    <option value="th" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_th')}</option>
                    <option value="tr" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_tr')}</option>
                    <option value="vi" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t('preferences.lang_vi')}</option>
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
                  <span style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f8fafc' }}>{t('preferences.usePdfWorker', 'Use Built-in PDF Viewer')}</span>
                  <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>- {t('preferences.usePdfWorkerDesc', 'Open PDF files with internal PDF worker by default')}</span>
                </label>
              </div>
              <div className="preference-item" style={{ flexDirection: 'row', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
                <input
                  type="checkbox"
                  id="imageViewerCheckbox"
                  checked={useImageViewer}
                  onChange={(e) => setUseImageViewer(e.target.checked)}
                  style={{ width: '16px', height: '16px', margin: 0, cursor: 'pointer' }}
                />
                <label htmlFor="imageViewerCheckbox" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', margin: 0, flex: 1 }}>
                  <span style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f8fafc' }}>{t('preferences.useImageViewer', 'Use Built-in Image Viewer')}</span>
                  <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>- {t('preferences.useImageViewerDesc', 'Open image files with internal image viewer by default')}</span>
                </label>
              </div>
              <div className="preference-item" style={{ flexDirection: 'row', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
                <input
                  type="checkbox"
                  id="videoPlayerCheckbox"
                  checked={useVideoPlayer}
                  onChange={(e) => setUseVideoPlayer(e.target.checked)}
                  style={{ width: '16px', height: '16px', margin: 0, cursor: 'pointer' }}
                />
                <label htmlFor="videoPlayerCheckbox" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', margin: 0, flex: 1 }}>
                  <span style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f8fafc' }}>{t('preferences.useVideoPlayer', 'Use Built-in Video Player')}</span>
                  <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>- {t('preferences.useVideoPlayerDesc', 'Open video files with internal video player by default')}</span>
                </label>
              </div>
              <div className="preference-item" style={{ marginTop: '8px' }}>
                <span className="label-text">PDF Export Directory (Leave empty to use same directory as original file)</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    value={pdfExportPath}
                    onChange={(e) => setPdfExportPath(e.target.value)}
                    placeholder="e.g. C:\Users\Document\PDFs"
                    style={{ flex: 1 }}
                  />
                  <button className="btn-secondary" onClick={async () => {
                    const selected = await open({
                      directory: true,
                      multiple: false,
                      defaultPath: pdfExportPath || undefined,
                    });
                    if (selected && typeof selected === 'string') {
                      setPdfExportPath(selected);
                    }
                  }}>
                    Browse
                  </button>
                </div>
              </div>
              <div className="preference-item">
                <span className="label-text">{t('preferences.columnsTitle')}</span>
                <div className="column-settings-list" style={{ marginTop: '10px', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '6px', backgroundColor: '#0b0f19' }}>
                  {columnSettings.map((col, index) => (
                    <div key={col.key} style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: index === columnSettings.length - 1 ? 'none' : '1px solid rgba(255, 255, 255, 0.06)', color: '#f8fafc' }}>
                      <input
                        type="checkbox"
                        checked={col.visible}
                        onChange={() => handleToggleColumn(col.key)}
                        style={{ marginRight: '12px' }}
                      />
                      <span style={{ flex: 1, fontSize: '0.9rem' }}>{columnLabels[col.key]}</span>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button className="btn-mini" onClick={() => handleMoveColumn(index, 'up')} disabled={index === 0} style={{ backgroundColor: '#1e293b', color: '#94a3b8', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer' }}>▲</button>
                        <button className="btn-mini" onClick={() => handleMoveColumn(index, 'down')} disabled={index === columnSettings.length - 1} style={{ backgroundColor: '#1e293b', color: '#94a3b8', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer' }}>▼</button>
                      </div>
                    </div>
                  ))}
                </div>
                <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '6px' }}>
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
        </div>
        <div className="preference-footer">
          <button className="btn-secondary" onClick={onClose}>{t('preferences.cancel')}</button>
          <button className="btn-primary" onClick={handleSave}>{t('preferences.saveChanges')}</button>
        </div>
      </div>

      {/* Custom Alert Modal */}
      {alertMessage && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,23,42,0.6)', zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.2s ease' }}>
          <div style={{ backgroundColor: '#ffffff', padding: '24px', borderRadius: '12px', minWidth: '320px', maxWidth: '400px', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)' }}>
            <h3 style={{ marginTop: 0, marginBottom: '12px', color: '#0f172a', fontSize: '1.2rem', fontWeight: 600 }}>{alertMessage.title}</h3>
            <p style={{ color: '#475569', marginBottom: '24px', fontSize: '0.95rem', lineHeight: '1.5' }}>{alertMessage.message}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn-primary" onClick={() => setAlertMessage(null)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Confirm Modal */}
      {confirmAction && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,23,42,0.6)', zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.2s ease' }}>
          <div style={{ backgroundColor: '#ffffff', padding: '24px', borderRadius: '12px', minWidth: '320px', maxWidth: '400px', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)' }}>
            <h3 style={{ marginTop: 0, marginBottom: '12px', color: '#0f172a', fontSize: '1.2rem', fontWeight: 600 }}>{confirmAction.title}</h3>
            <p style={{ color: '#475569', marginBottom: '24px', fontSize: '0.95rem', lineHeight: '1.5' }}>{confirmAction.message}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button className="btn-secondary" onClick={() => setConfirmAction(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => { confirmAction.onConfirm(); setConfirmAction(null); }}>Continue</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}