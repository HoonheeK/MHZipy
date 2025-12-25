import { useState, useEffect } from 'react';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import Menu from './Menu/Menu';
import FileExplorer from './FileExplorer/FileExplorer';
import PreferenceDialog from './Preference/PreferenceDialog';
import './App.css';

interface AppConfig {
  defaultPath: string;
  quickAccess: string[];
  sidebarWidth?: number;
  expandedPaths?: string[];
  quickAccessHeight?: number;
  view?: 'folder' | 'search';
}

function App() {
  const [config, setConfig] = useState<AppConfig>({ defaultPath: 'C:', quickAccess: [] });
  const [isPrefOpen, setIsPrefOpen] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [currentView, setCurrentView] = useState<'folder' | 'search'>('folder');

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
      if (!(await exists(configDir))) {
        await mkdir(configDir, { recursive: true });
      }
      const configPath = await join(configDir, 'config.json');
      await writeTextFile(configPath, JSON.stringify(newConfig, null, 2));
    } catch (e) {
      console.error('Failed to save config:', e);
    }
  };

  if (!configLoaded) return null;

  return (
    <div className="app-wrapper">
      <Menu 
        onPreference={() => setIsPrefOpen(true)} 
        currentView={currentView}
        onToggleView={() => saveConfig({ view: currentView === 'folder' ? 'search' : 'folder' })}
      />
      <FileExplorer config={config} onSaveConfig={saveConfig} currentView={currentView} />
      <PreferenceDialog 
        isOpen={isPrefOpen}
        onClose={() => setIsPrefOpen(false)}
        initialDefaultPath={config.defaultPath}
        initialQuickAccessFolders={config.quickAccess}
        onSave={(newDefault, newQuick) => saveConfig({ defaultPath: newDefault, quickAccess: newQuick })}
      />
    </div>
  );
}

export default App;