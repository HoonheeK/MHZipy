import { useState, useEffect } from 'react';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import Menu from './Menu/Menu';
import FileExplorer from './FileExplorer/FileExplorer';
import PreferenceDialog from './Menu/PreferenceDialog';
import { ensureDir } from './utils/fileOps';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
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
}

function App() {
  const [config, setConfig] = useState<AppConfig>({ defaultPath: 'C:', quickAccess: [] });
  const [isPrefOpen, setIsPrefOpen] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [currentView, setCurrentView] = useState<'folder' | 'search'>('folder');
  const [searchQuery, setSearchQuery] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [forwardHistory, setForwardHistory] = useState<string[]>([]);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [requestedPath, setRequestedPath] = useState<string | undefined>(undefined);
  const [requestedSelect, setRequestedSelect] = useState<string | undefined>(undefined);


  useEffect(() => {
    const initConfig = async () => {
      console.log('[App] initConfig: 시작됨');
      try {
        // 1. URL 파라미터 우선 처리 (설정 로드 실패와 무관하게 동작해야 함)
        const params = new URLSearchParams(window.location.search);
        const pathParam = params.get('path');
        const selectParam = params.get('select');
        console.log(`[App] URL 파라미터 확인: path="${pathParam}", select="${selectParam}"`);

        if (pathParam) {
          console.log(`[App] URL 경로 감지됨. 뷰를 "folder"로 전환하고 경로를 "${pathParam}"으로 요청합니다.`);
          setCurrentView('folder'); 
          setRequestedPath(pathParam);
          if (selectParam) {
            setRequestedSelect(selectParam);
          }
        }

        const configDir = await appConfigDir();
        const configPath = await join(configDir, 'config.json');
        console.log(`[App] 설정 파일 경로: ${configPath}`);

        if (await exists(configPath)) {
          const content = await readTextFile(configPath);
          const parsed = JSON.parse(content);
          console.log('[App] 설정 파일 로드 성공:', parsed);
          setConfig(parsed);

          // URL 경로가 없을 때만 저장된 기본 뷰/경로 사용
          if (!pathParam) {
            console.log('[App] URL 경로 없음. 기존 설정(parsed.view, parsed.defaultPath)을 사용합니다.');
            if (parsed.view) setCurrentView(parsed.view);
            if (parsed.defaultPath && !currentPath) {
              setCurrentPath(parsed.defaultPath);
            }
          }
          if (parsed.search && parsed.search.query) {
            setSearchQuery(parsed.search.query);
          }
        } else {
          console.warn('[App] 설정 파일(config.json)이 존재하지 않습니다.');
        }
      } catch (e) {
        console.error('[App] 설정 로드 실패:', e);
      } finally {
        setConfigLoaded(true);
        console.log('[App] 설정 로드 프로세스 완료 (configLoaded=true)');
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

  const saveConfig = async (updates: Partial<AppConfig>) => {
    if (updates.view) {
      setCurrentView(updates.view);
    }
    const newConfig = { ...config, ...updates };
    setConfig(newConfig);
    try {
      const configDir = await appConfigDir();
      await ensureDir(configDir);
      const configPath = await join(configDir, 'config.json');
      // Log config path and contents when saving
      try {
        // console.log('Saving config.json to:', configPath);
        // console.log('config.json contents:', JSON.stringify(newConfig, null, 2));
      } catch (logErr) {
        console.error('Failed to log config save:', logErr);
      }
      await writeTextFile(configPath, JSON.stringify(newConfig, null, 2));
    } catch (e) {
      console.error('Failed to save config:', e);
    }
  };

  // 앱 실행 시 백그라운드로 MFT 인덱싱을 자동 실행 (비동기, UI 차단 없음)
  useEffect(() => {
    if (!configLoaded) return;
    // invoke를 기다리지 않고 백그라운드에서 진행시키되, 완료/오류는 로그로 남김
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
        console.error('Background MFT indexing failed:', err);
        try {
          localStorage.setItem('mft_index_ready', 'false');
          emit('index-ready', false);
        } catch (e) {
          console.warn('Failed to persist or emit index-ready flag after failure:', e);
        }
      });
    // 의도적으로 의존성은 빈 배열이나 configLoaded로 제어: 한번만 실행
  }, [configLoaded]);

  const handleFileExplorerNavigate = (path: string) => {
    if (path === currentPath) return;

    // If this navigation matches the requested back navigation
    if (path === requestedPath) {
      setRequestedPath(undefined);
      setRequestedSelect(undefined);
      setCurrentPath(path);
      return;
    }

    // Normal navigation: push current to history
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
      <Menu
        onPreference={() => setIsPrefOpen(true)}
        currentView={currentView}
        onToggleView={() => saveConfig({ view: currentView === 'folder' ? 'search' : 'folder' })}
        onSearch={setSearchQuery}
        onBack={handleBack}
        canGoBack={history.length > 0}
        onNext={handleNext}
        canGoForward={forwardHistory.length > 0}
        searchQuery={searchQuery}
      />
      <FileExplorer
        config={config}
        onSaveConfig={saveConfig}
        currentView={currentView}
        searchQuery={searchQuery}
        externalPath={requestedPath}
        externalSelect={requestedSelect}
        onNavigate={handleFileExplorerNavigate}
      />
      <PreferenceDialog
        isOpen={isPrefOpen}
        onClose={() => setIsPrefOpen(false)}
        initialDefaultPath={config.defaultPath}
        initialQuickAccessFolders={config.quickAccess}
        initialEditableFolders={config.editableFolders}
        initialReadonlyFolders={config.readonlyFolders}
        initialColumnSettings={config.columnSettings}
        onSave={(newDefault: string, newQuick?: string[], newEditable?: string[], newReadonly?: string[], newColumnSettings?: { key: string; visible: boolean }[]) => {
          saveConfig({
            defaultPath: newDefault,
            quickAccess: newQuick ?? config.quickAccess,
            editableFolders: newEditable ?? config.editableFolders,
            readonlyFolders: newReadonly ?? config.readonlyFolders,
            columnSettings: newColumnSettings,
          });
        }}
      />
    </div>
  );
}

export default App;