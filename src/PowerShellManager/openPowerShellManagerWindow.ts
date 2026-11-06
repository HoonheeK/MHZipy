import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';

export interface PowerShellManagerLaunchTarget {
  workingDir?: string;
  selectedFiles?: string[];
  scriptFilePath?: string;
}

const PS_MANAGER_LABEL = 'powershell-manager';

/**
 * MHZipy PowerShell Studio / Manager 독립 윈도우를 열거나,
 * 이미 열려 있으면 포커스 후 현재 폴더/선택된 파일 컨텍스트를 전달합니다.
 */
export const openPowerShellManagerWindow = async (target: PowerShellManagerLaunchTarget = {}) => {
  const payload = {
    workingDir: target.workingDir || '',
    selectedFiles: target.selectedFiles || [],
    scriptFilePath: target.scriptFilePath || '',
  };

  try {
    const existingWin = await WebviewWindow.getByLabel(PS_MANAGER_LABEL);
    if (existingWin) {
      await existingWin.unminimize();
      await existingWin.setFocus();
      await emit('mhz-ps-manager-context', payload);
      return;
    }
  } catch {
    // Window does not exist yet
  }

  try {
    // Cache initial context in localStorage so the new window can read it immediately on mount
    try {
      localStorage.setItem('mhz_ps_initial_context', JSON.stringify(payload));
    } catch {}

    let posX: number | undefined;
    let posY: number | undefined;
    try {
      const currentWin = getCurrentWindow();
      const position = await currentWin.outerPosition();
      posX = Math.max(0, position.x + 48);
      posY = Math.max(0, position.y + 48);
    } catch {}

    const params = new URLSearchParams({
      view: 'powershell-manager',
      workingDir: payload.workingDir,
      scriptFilePath: payload.scriptFilePath,
    });

    const webview = new WebviewWindow(PS_MANAGER_LABEL, {
      url: `index.html?${params.toString()}`,
      title: '⚡ MHZipy PowerShell Studio & Result Manager',
      width: 1180,
      height: 780,
      minWidth: 760,
      minHeight: 520,
      decorations: false,
      ...(posX !== undefined && posY !== undefined ? { x: posX, y: posY } : {}),
    });

    webview.once('tauri://error', (e) => {
      console.error('PowerShell Manager Window creation error:', e);
    });
  } catch (error) {
    console.error('Failed to open PowerShell Manager window:', error);
    await message(`Failed to open PowerShell Manager: ${String(error)}`, {
      title: 'PowerShell Manager Error',
      kind: 'error',
    });
  }
};

