import { BaseDirectory, readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';

const CONFIG_FILE = 'config.json';

export interface AppConfig {
  sidebarWidth?: number;
  expandedPaths?: string[];
  defaultPath?: string;
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const configExists = await exists(CONFIG_FILE, { baseDir: BaseDirectory.AppLocalData });
    if (!configExists) {
      return {};
    }
    const content = await readTextFile(CONFIG_FILE, { baseDir: BaseDirectory.AppLocalData });
    return JSON.parse(content);
  } catch (error) {
    console.error('Failed to load config:', error);
    return {};
  }
}

export async function saveConfig(newConfig: Partial<AppConfig>): Promise<void> {
  try {
    const currentConfig = await loadConfig();
    const finalConfig = { ...currentConfig, ...newConfig };
    
    await writeTextFile(CONFIG_FILE, JSON.stringify(finalConfig, null, 2), { baseDir: BaseDirectory.AppLocalData });
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}