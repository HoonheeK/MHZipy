import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';

const CONFIG_FILE = 'config.json';

export interface AppConfig {
  sidebarWidth?: number;
  lastOpenedPath?: string;
  expandedPaths?: string[];
  defaultPath?: string;
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    if (await exists(CONFIG_FILE)) {
      const content = await readTextFile(CONFIG_FILE);
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }
  return {};
}

export async function saveConfig(config: Partial<AppConfig>) {
  try {
    let current: AppConfig = {};
    if (await exists(CONFIG_FILE)) {
      const content = await readTextFile(CONFIG_FILE);
      current = JSON.parse(content);
    }
    const newConfig = { ...current, ...config };
    await writeTextFile(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}