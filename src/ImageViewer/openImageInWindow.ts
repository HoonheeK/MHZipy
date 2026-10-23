import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { message } from '@tauri-apps/plugin-dialog';
import i18n from '../i18n';

export interface ImageFileTarget {
  path: string;
  name: string;
}

/**
 * 이미지 파일을 별도의 고성능 이미지 뷰어 윈도우로 실행합니다.
 * decorations: false로 생성하여 커스텀 타이틀바 및 윈도우 컨트롤을 사용합니다.
 */
export const openImageInWindow = async (file: ImageFileTarget) => {
  // 경로 기반 고유 윈도우 라벨 (영문/숫자/-/_ 만 허용)
  const sanitizedPath = file.path.replace(/[^a-zA-Z0-9-_]/g, '_');
  const windowLabel = `image-viewer-${sanitizedPath}`;

  try {
    const existingWin = await WebviewWindow.getByLabel(windowLabel);
    if (existingWin) {
      await existingWin.unminimize();
      await existingWin.setFocus();
      return;
    }
  } catch (e) {
    // 윈도우가 아직 존재하지 않음
  }

  try {
    let posX: number | undefined;
    let posY: number | undefined;
    try {
      const currentWin = getCurrentWindow();
      const position = await currentWin.outerPosition();
      posX = Math.max(0, position.x + 40);
      posY = Math.max(0, position.y + 40);
    } catch (e) {
      console.warn('현재 창 위치를 가져올 수 없습니다:', e);
    }

    const currentLang = i18n.language || 'en';
    const webview = new WebviewWindow(windowLabel, {
      url: `index.html?view=image-viewer&filePath=${encodeURIComponent(file.path)}&title=${encodeURIComponent(file.name)}&lang=${encodeURIComponent(currentLang)}`,
      title: `${file.name} - MHZipy Image Viewer`,
      width: 1120,
      height: 820,
      minWidth: 640,
      minHeight: 480,
      decorations: false,
      ...(posX !== undefined && posY !== undefined ? { x: posX, y: posY } : {}),
    });

    webview.once('tauri://error', (e) => {
      console.error('Image Viewer Window creation error:', e);
    });

    console.log(`Image Viewer 윈도우 시작됨: ${file.name} (${file.path})`);
  } catch (error) {
    console.error('이미지 뷰어를 열 수 없습니다:', error);
    await message(`이미지 뷰어를 열 수 없습니다: ${String(error)}`, {
      title: '오류',
      kind: 'error',
    });
  }
};
