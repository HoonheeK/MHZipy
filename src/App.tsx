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

interface AppConfig {
  defaultPath: string;
  quickAccess: string[];
  sidebarWidth?: number;
  expandedPaths?: string[];
  quickAccessHeight?: number;
  view?: 'folder' | 'search';
  editableFolders?: string[];
  readonlyFolders?: string[];
}

function App() {
  const [config, setConfig] = useState<AppConfig>({ defaultPath: 'C:', quickAccess: [] });
  const [isPrefOpen, setIsPrefOpen] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [currentView, setCurrentView] = useState<'folder' | 'search'>('folder');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const initConfig = async () => {
      try {
        const configDir = await appConfigDir();
        const configPath = await join(configDir, 'config.json');
        if (await exists(configPath)) {
          const content = await readTextFile(configPath);
          const parsed = JSON.parse(content);
          setConfig(parsed);
          if (parsed.view) setCurrentView(parsed.view);
        }
      } catch (e) {
        console.error('Failed to load config:', e);
      } finally {
        setConfigLoaded(true);
      }
    };
    initConfig();
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
        console.log('Saving config.json to:', configPath);
        console.log('config.json contents:', JSON.stringify(newConfig, null, 2));
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

  if (!configLoaded) return null;

  return (
    <div className="app-wrapper">
      <Menu 
        onPreference={() => setIsPrefOpen(true)} 
        currentView={currentView}
        onToggleView={() => saveConfig({ view: currentView === 'folder' ? 'search' : 'folder' })}
        onSearch={setSearchQuery}
      />
      <FileExplorer config={config} onSaveConfig={saveConfig} currentView={currentView} searchQuery={searchQuery} />
      <PreferenceDialog 
        isOpen={isPrefOpen}
        onClose={() => setIsPrefOpen(false)}
        initialDefaultPath={config.defaultPath}
        initialQuickAccessFolders={config.quickAccess}
        initialEditableFolders={config.editableFolders}
        initialReadonlyFolders={config.readonlyFolders}
        onSave={(newDefault: string, newQuick?: string[], newEditable?: string[], newReadonly?: string[]) => {
          saveConfig({ 
            defaultPath: newDefault, 
            quickAccess: newQuick ?? config.quickAccess,
            editableFolders: newEditable ?? config.editableFolders,
            readonlyFolders: newReadonly ?? config.readonlyFolders,
          });
        }}
      />
    </div>
  );
}

export default App;