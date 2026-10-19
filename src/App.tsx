import { useState, useEffect, useRef } from 'react';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import Toolbar from './components/Toolbar/Toolbar';
import FileExplorer, { FileExplorerRef, SelectionStatus } from './FileExplorer/FileExplorer';
import PreferenceDialog from './Menu/PreferenceDialog';
import AboutDialog from './Menu/AboutDialog';
import OpenSourceDialog from './Menu/OpenSourceDialog';
import LicenseExpiredDialog from './components/LicenseExpiredDialog';
import LicenseDialog from './components/LicenseDialog';
import { ensureDir } from './utils/fileOps';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useTranslation } from 'react-i18next';
import { checkForUpdates } from './utils/updater';
import PdfProgressDialog from './common/PdfProgressDialog';
import './App.css';

export interface SearchConfig {
  query: string;
  useRegex: boolean;
  sizeQuery: string;
  type: string;
  dateAfter: string;
  dateBefore: string;
  showFilters: boolean;
  searchMode: 'index' | 'directory';
  directorySearchPaths: string[];
}

export type LicenseStatus = { Trial: { days_left: number } } | { Activated: { expiry_date: number } } | "Expired";

export interface LicenseInfo {
  status: LicenseStatus;
  device_id: string;
}

interface AppConfig {
  defaultPath: string;
  quickAccess: string[];
  sidebarWidth?: number;
  expandedPaths?: string[];
  quickAccessHeight?: number;
  view?: 'folder' | 'search';
  editableFolders?: string[];
  readonlyFolders?: string[];
  search?: SearchConfig;
  columnSettings?: { key: string; visible: boolean }[];
  language?: string;
  usePdfWorker?: boolean;
  licenseEmail?: string;
  licenseCode?: string;
  recentOpenedFolders?: string[];
  disableUpdateCheck?: boolean;
  pdfExportPath?: string;
  zoomLevel?: number;
}

function App() {
  const [config, setConfig] = useState<AppConfig>({ defaultPath: 'C:', quickAccess: [] });
  const [zoomLevel, setZoomLevel] = useState<number>(1.0);
  const [showZoomHud, setShowZoomHud] = useState<boolean>(false);
  const zoomHudTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isPrefOpen, setIsPrefOpen] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [currentView, setCurrentView] = useState<'folder' | 'search'>('folder');
  const { i18n } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [forwardHistory, setForwardHistory] = useState<string[]>([]);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [requestedPath, setRequestedPath] = useState<string | undefined>(undefined);
  const [requestedSelect, setRequestedSelect] = useState<string | undefined>(undefined);
  const [licenseInfo, setLicenseInfo] = useState<LicenseInfo | null>(null);
  const [globalAlert, setGlobalAlert] = useState<{title: string, message: string} | null>(null);
  const [globalConfirm, setGlobalConfirm] = useState<{title: string, message: string, onConfirm: () => void} | null>(null);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isOpenSourceOpen, setIsOpenSourceOpen] = useState(false);
  const [isLicenseOpen, setIsLicenseOpen] = useState(false);
  const [pdfProgressOpen, setPdfProgressOpen] = useState(false);
  const [pdfProgressState, setPdfProgressState] = useState({ progress: 0, filename: '' });

  // FileExplorer ref to command file operations from top toolbar
  const fileExplorerRef = useRef<FileExplorerRef>(null);

  // Status of selection (to enable/disable/highlight toolbar buttons)
  const [selectionStatus, setSelectionStatus] = useState<SelectionStatus>({
    hasSelectedFiles: false,
    isZipSelected: false,
    canPaste: false,
    canGoUp: false,
    currentPath: '',
  });

  const applyZoom = async (zoom: number) => {
    let tauriApplied = false;
    try {
      const webview = getCurrentWebviewWindow();
      if (webview && typeof webview.setZoom === 'function') {
        await webview.setZoom(zoom);
        tauriApplied = true;
      }
    } catch (err) {
      console.warn('[App] Tauri webview setZoom failed, using CSS zoom fallback:', err);
    }

    if (!tauriApplied) {
      (document.documentElement.style as any).zoom = `${zoom}`;
    } else {
      (document.documentElement.style as any).zoom = '';
    }
  };

  const saveConfig = async (updates: Partial<AppConfig>) => {
    if (updates.view) {
      setCurrentView(updates.view);
    }
    if (updates.language) {
      i18n.changeLanguage(updates.language);
    }
    setConfig(prev => {
      const newConfig = { ...prev, ...updates };
      (async () => {
        try {
          const configDir = await appConfigDir();
          await ensureDir(configDir);
          const configPath = await join(configDir, 'config.json');
          await writeTextFile(configPath, JSON.stringify(newConfig, null, 2));
        } catch (e) {
          console.error('Failed to save config:', e);
        }
      })();
      return newConfig;
    });
  };

  const triggerZoomChange = (delta: number | 'reset') => {
    setZoomLevel(prev => {
      let next: number;
      if (delta === 'reset') {
        next = 1.0;
      } else {
        next = Math.max(0.5, Math.min(2.5, Math.round((prev + delta) * 10) / 10));
      }

      applyZoom(next);

      setShowZoomHud(true);
      if (zoomHudTimeoutRef.current) clearTimeout(zoomHudTimeoutRef.current);
      zoomHudTimeoutRef.current = setTimeout(() => setShowZoomHud(false), 1600);

      if (zoomSaveTimeoutRef.current) clearTimeout(zoomSaveTimeoutRef.current);
      zoomSaveTimeoutRef.current = setTimeout(() => {
        saveConfig({ zoomLevel: next });
      }, 500);

      return next;
    });
  };

  useEffect(() => {
    const unlistenProgress = listen<any>('pdf-conversion-progress', (event: any) => {
      setPdfProgressOpen(true);
      setPdfProgressState({
        progress: event.payload.processed,
        filename: event.payload.filename
      });
    });

    const unlistenComplete = listen<string>('pdf-conversion-complete', (event: any) => {
      setPdfProgressOpen(false);
      setGlobalConfirm({
        title: 'Conversion Complete',
        message: 'PDF conversion is complete. Do you want to open the PDF file?',
        onConfirm: () => {
          invoke('open_file', { path: event.payload });
        }
      });
    });

    const unlistenError = listen<string>('pdf-conversion-error', (event: any) => {
      setPdfProgressOpen(false);
      setGlobalAlert({
        title: 'Conversion Error',
        message: `Failed to convert PDF: ${event.payload}`
      });
    });

    return () => {
      unlistenProgress.then((f: UnlistenFn) => f());
      unlistenComplete.then((f: UnlistenFn) => f());
      unlistenError.then((f: UnlistenFn) => f());
    };
  }, []);

  useEffect(() => {
    const initConfig = async () => {
      try {
        // 1. URL 파라미터 우선 처리 (설정 로드 실패와 무관하게 동작해야 함)
        const params = new URLSearchParams(window.location.search);
        const pathParam = params.get('path');
        const selectParam = params.get('select');

        if (pathParam) {
          setCurrentView('folder');
          setRequestedPath(pathParam);
          if (selectParam) {
            setRequestedSelect(selectParam);
          }
        }

        const configDir = await appConfigDir();
        const configPath = await join(configDir, 'config.json');

        if (await exists(configPath)) {
          const content = await readTextFile(configPath);
          const parsed = JSON.parse(content);

          setConfig(parsed);
          if (parsed.language) {
            i18n.changeLanguage(parsed.language);
          }

          // URL 경로가 없을 때만 저장된 기본 뷰/경로 사용
          if (!pathParam) {
            if (parsed.view) setCurrentView(parsed.view);
            if (parsed.defaultPath && !currentPath) {
              setCurrentPath(parsed.defaultPath);
            }
          }
          if (parsed.search && parsed.search.query) {
            setSearchQuery(parsed.search.query);
          }
          if (typeof parsed.zoomLevel === 'number' && parsed.zoomLevel >= 0.5 && parsed.zoomLevel <= 2.5) {
            setZoomLevel(parsed.zoomLevel);
            applyZoom(parsed.zoomLevel);
          }
          if (!parsed.disableUpdateCheck) {
            checkForUpdates(
              false,
              (title, message) => setGlobalAlert({title, message}),
              (title, message, onYes) => setGlobalConfirm({title, message, onConfirm: onYes})
            );
          }
        } else {
          console.warn('[App] 설정 파일(config.json)이 존재하지 않습니다.');
          checkForUpdates(
            false,
            (title, message) => setGlobalAlert({title, message}),
            (title, message, onYes) => setGlobalConfirm({title, message, onConfirm: onYes})
          );
        }

        try {
          const info: LicenseInfo = await invoke('get_license_info');
          setLicenseInfo(info);
        } catch (e) {
          console.error('[App] 라이센스 정보 로드 실패:', e);
        }
      } catch (e) {
        console.error('[App] 설정 로드 실패:', e);
      } finally {
        setConfigLoaded(true);
      }
    };
    initConfig();
  }, []);

  // 웹뷰의 기본 파일 드롭 동작(파일 열기) 방지
  useEffect(() => {
    const stopDefault = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", stopDefault, false);
    window.addEventListener("drop", stopDefault, false);
    return () => {
      window.removeEventListener("dragover", stopDefault);
      window.removeEventListener("drop", stopDefault);
    };
  }, []);

  // Ctrl + Mouse Wheel Zoom
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.1 : -0.1;
        triggerZoomChange(delta);
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // Global Shortcuts: Alt+P (Preferences), Ctrl+Plus/Minus/0 (Zoom In/Out/Reset)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setIsPrefOpen(prev => !prev);
      } else if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key === '=' || e.key === '+' || e.key === 'Add') {
          e.preventDefault();
          triggerZoomChange(0.1);
        } else if (e.key === '-' || e.key === 'Subtract') {
          e.preventDefault();
          triggerZoomChange(-0.1);
        } else if (e.key === '0') {
          e.preventDefault();
          triggerZoomChange('reset');
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Cleanup timeout references on unmount
  useEffect(() => {
    return () => {
      if (zoomHudTimeoutRef.current) clearTimeout(zoomHudTimeoutRef.current);
      if (zoomSaveTimeoutRef.current) clearTimeout(zoomSaveTimeoutRef.current);
    };
  }, []);

  // 앱 실행 시 MFT 인덱스 상태 확인 (기존 인덱스가 준비되어 있지 않을 때만 최초 1회 백그라운드 인덱싱 시도)
  useEffect(() => {
    if (!configLoaded) return;
    const isReady = localStorage.getItem('mft_index_ready');
    if (isReady === 'true') {
      return; // 이미 인덱스가 저장되어 있으므로 백엔드의 setup(load_from_disk)에서 자동 로드됨
    }

    invoke<number>('build_mft_index')
      .then((count) => {
        console.log(`Background MFT indexing completed. ${count} files indexed.`);
        try {
          localStorage.setItem('mft_index_ready', 'true');
          emit('index-ready', true);
        } catch (e) {
          console.warn('Failed to persist or emit index-ready flag:', e);
        }
      })
      .catch((err) => {
        console.warn('Initial background MFT indexing skipped or failed:', err);
      });
  }, [configLoaded]);

  const handleFileExplorerNavigate = (path: string) => {
    if (path === currentPath) return;

    if (path === requestedPath) {
      setRequestedPath(undefined);
      setRequestedSelect(undefined);
      setCurrentPath(path);
      return;
    }

    if (currentPath) {
      setHistory(prev => [...prev, currentPath]);
    }
    setForwardHistory([]);
    setCurrentPath(path);
  };

  const handleBack = () => {
    if (history.length === 0) return;
    setForwardHistory(prev => [...prev, currentPath]);
    const prevPath = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1));
    setRequestedPath(prevPath);
  };

  const handleNext = () => {
    if (forwardHistory.length === 0) return;
    setHistory(prev => [...prev, currentPath]);
    const nextPath = forwardHistory[forwardHistory.length - 1];
    setForwardHistory(prev => prev.slice(0, -1));
    setRequestedPath(nextPath);
  };

  if (!configLoaded) return null;

  return (
    <div className="app-wrapper">
      {/* 1. Modern Unified Toolbar (Inspired by MHImageViewer) */}
      <Toolbar
        onAbout={() => setIsAboutOpen(true)}
        onOpenSource={() => setIsOpenSourceOpen(true)}
        onPreference={() => setIsPrefOpen(true)}
        onLicense={() => setIsLicenseOpen(true)}
        onBack={handleBack}
        canGoBack={history.length > 0}
        onNext={handleNext}
        canGoForward={forwardHistory.length > 0}
        onGoUp={() => fileExplorerRef.current?.goUp()}
        canGoUp={selectionStatus.canGoUp}
        onRefresh={() => fileExplorerRef.current?.refresh()}
        currentPath={currentPath}
        onNavigatePath={(p) => fileExplorerRef.current?.navigate(p)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        hasSelectedFiles={selectionStatus.hasSelectedFiles}
        isZipSelected={selectionStatus.isZipSelected}
        onCompress={() => fileExplorerRef.current?.compress()}
        onExtract={() => fileExplorerRef.current?.extract()}
        onNewFolder={() => fileExplorerRef.current?.newFolder()}
        onCopy={() => fileExplorerRef.current?.copy()}
        onPaste={() => fileExplorerRef.current?.paste()}
        canPaste={selectionStatus.canPaste}
        onDelete={() => fileExplorerRef.current?.deleteSelected()}
        currentView={currentView}
        onToggleView={(view) => saveConfig({ view })}
      />

      {/* 2. Main File Explorer Pane */}
      <FileExplorer
        ref={fileExplorerRef}
        config={config}
        onSaveConfig={saveConfig}
        currentView={currentView}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        externalPath={requestedPath}
        externalSelect={requestedSelect}
        pdfExportPath={config.pdfExportPath}
        onNavigate={handleFileExplorerNavigate}
        onSelectionStatusChange={setSelectionStatus}
      />

      {/* 3. Preferences Dialog */}
      <PreferenceDialog
        isOpen={isPrefOpen}
        onClose={() => setIsPrefOpen(false)}
        initialDefaultPath={config.defaultPath}
        initialQuickAccessFolders={config.quickAccess}
        initialEditableFolders={config.editableFolders}
        initialReadonlyFolders={config.readonlyFolders}
        initialColumnSettings={config.columnSettings}
        initialLanguage={config.language}
        initialUsePdfWorker={config.usePdfWorker}
        initialLicenseEmail={config.licenseEmail}
        initialLicenseCode={config.licenseCode}
        initialDisableUpdateCheck={config.disableUpdateCheck}
        initialPdfExportPath={config.pdfExportPath}
        onSave={(newDefault: string, newQuick?: string[], newEditable?: string[], newReadonly?: string[], newColumnSettings?: { key: string; visible: boolean }[], newLanguage?: string, newUsePdfWorker?: boolean, newLicenseEmail?: string, newLicenseCode?: string, newDisableUpdateCheck?: boolean, newPdfExportPath?: string) => {
          saveConfig({
            defaultPath: newDefault,
            quickAccess: newQuick ?? config.quickAccess,
            editableFolders: newEditable ?? config.editableFolders,
            readonlyFolders: newReadonly ?? config.readonlyFolders,
            columnSettings: newColumnSettings,
            language: newLanguage,
            usePdfWorker: newUsePdfWorker,
            licenseEmail: newLicenseEmail,
            licenseCode: newLicenseCode,
            disableUpdateCheck: newDisableUpdateCheck,
            pdfExportPath: newPdfExportPath,
          });
        }}
        licenseInfo={licenseInfo}
        onActivateLicense={async (email, code) => {
          const newInfo: LicenseInfo = await invoke('activate_license', { email, code });
          setLicenseInfo(newInfo);
        }}
      />

      {/* 4. Dedicated License Dialog */}
      <LicenseDialog
        isOpen={isLicenseOpen}
        onClose={() => setIsLicenseOpen(false)}
        licenseInfo={licenseInfo}
        defaultEmail={config.licenseEmail}
        defaultCode={config.licenseCode}
        onActivate={(newInfo, email, code) => {
          setLicenseInfo(newInfo);
          saveConfig({
            licenseEmail: email,
            licenseCode: code,
          });
        }}
      />

      {/* 5. License Expired Blocking Overlay */}
      {licenseInfo && licenseInfo.status === 'Expired' && (
        <LicenseExpiredDialog
          licenseInfo={licenseInfo}
          defaultEmail={config.licenseEmail}
          defaultCode={config.licenseCode}
          onActivated={(newInfo, email, code) => {
            setLicenseInfo(newInfo);
            saveConfig({
              licenseEmail: email,
              licenseCode: code,
            });
          }}
        />
      )}

      {/* 5. About & Open Source Dialogs */}
      <AboutDialog 
        isOpen={isAboutOpen} 
        onClose={() => setIsAboutOpen(false)} 
        disableUpdateCheck={config.disableUpdateCheck}
        onToggleUpdateCheck={(disabled) => saveConfig({ ...config, disableUpdateCheck: disabled })}
      />
      <OpenSourceDialog isOpen={isOpenSourceOpen} onClose={() => setIsOpenSourceOpen(false)} />

      {/* 6. Global Custom Alert Modal */}
      {globalAlert && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(10, 15, 29, 0.75)', backdropFilter: 'blur(10px)', zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.2s ease' }}>
          <div style={{ backgroundColor: '#0f172a', border: '1px solid rgba(255, 255, 255, 0.12)', padding: '24px', borderRadius: '12px', minWidth: '320px', maxWidth: '420px', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.8), 0 0 24px rgba(56, 189, 248, 0.15)' }}>
            <h3 style={{ marginTop: 0, marginBottom: '12px', color: '#f1f5f9', fontSize: '1.15rem', fontWeight: 600 }}>{globalAlert.title}</h3>
            <p style={{ color: '#cbd5e1', marginBottom: '24px', fontSize: '0.92rem', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>{globalAlert.message}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                style={{ padding: '8px 20px', backgroundColor: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer' }}
                onClick={() => setGlobalAlert(null)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7. Global Custom Confirm Modal */}
      {globalConfirm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(10, 15, 29, 0.75)', backdropFilter: 'blur(10px)', zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.2s ease' }}>
          <div style={{ backgroundColor: '#0f172a', border: '1px solid rgba(255, 255, 255, 0.12)', padding: '24px', borderRadius: '12px', minWidth: '320px', maxWidth: '420px', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.8), 0 0 24px rgba(56, 189, 248, 0.15)' }}>
            <h3 style={{ marginTop: 0, marginBottom: '12px', color: '#f1f5f9', fontSize: '1.15rem', fontWeight: 600 }}>{globalConfirm.title}</h3>
            <p style={{ color: '#cbd5e1', marginBottom: '24px', fontSize: '0.92rem', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>{globalConfirm.message}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                style={{ padding: '8px 18px', backgroundColor: 'rgba(255, 255, 255, 0.08)', color: '#e2e8f0', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '6px', fontWeight: 500, cursor: 'pointer' }}
                onClick={() => setGlobalConfirm(null)}
              >
                Cancel
              </button>
              <button
                style={{ padding: '8px 20px', backgroundColor: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer' }}
                onClick={() => { globalConfirm.onConfirm(); setGlobalConfirm(null); }}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 8. PDF Progress Modal */}
      <PdfProgressDialog 
        isOpen={pdfProgressOpen} 
        onClose={() => setPdfProgressOpen(false)} 
        progress={pdfProgressState.progress} 
        filename={pdfProgressState.filename} 
      />

      {/* 9. Zoom Indicator HUD */}
      {showZoomHud && (
        <div
          className="zoom-hud"
          onMouseEnter={() => {
            if (zoomHudTimeoutRef.current) clearTimeout(zoomHudTimeoutRef.current);
          }}
          onMouseLeave={() => {
            if (zoomHudTimeoutRef.current) clearTimeout(zoomHudTimeoutRef.current);
            zoomHudTimeoutRef.current = setTimeout(() => setShowZoomHud(false), 1200);
          }}
        >
          <span>🔍 {Math.round(zoomLevel * 100)}%</span>
          <button
            className="zoom-hud-btn"
            title="Zoom Out (Ctrl -)"
            onClick={() => triggerZoomChange(-0.1)}
          >
            -
          </button>
          <button
            className="zoom-hud-btn"
            title="Zoom In (Ctrl +)"
            onClick={() => triggerZoomChange(0.1)}
          >
            +
          </button>
          {zoomLevel !== 1.0 && (
            <button
              className="zoom-hud-btn"
              title="Reset Zoom (Ctrl 0)"
              onClick={() => triggerZoomChange('reset')}
            >
              100%
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default App;