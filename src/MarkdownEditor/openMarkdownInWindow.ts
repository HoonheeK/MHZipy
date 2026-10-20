import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { message } from '@tauri-apps/plugin-dialog';

export interface MarkdownFileTarget {
  path: string;
  name: string;
}

/**
 * MD 및 Text 파일을 별도의 독립 윈도우로 실행합니다.
 * decorations: false로 생성하여 커스텀 타이틀바 및 윈도우 컨트롤(최소화, 최대화, 닫기)을 사용합니다.
 */
export const openMarkdownInWindow = async (file: MarkdownFileTarget) => {
  // 경로 기반 고유 윈도우 라벨 (영문/숫자/-/_ 만 허용)
  const sanitizedPath = file.path.replace(/[^a-zA-Z0-9-_]/g, '_');
  const windowLabel = `md-editor-${sanitizedPath}`;

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
    // 현재 창 위치를 기준으로 약간 오프셋된 위치에 새 창을 띄움
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

    const webview = new WebviewWindow(windowLabel, {
      url: `index.html?view=markdown-editor&filePath=${encodeURIComponent(file.path)}&title=${encodeURIComponent(file.name)}`,
      title: `${file.name} - MHZipy Markdown Editor`,
      width: 1080,
      height: 760,
      minWidth: 600,
      minHeight: 450,
      decorations: false,
      ...(posX !== undefined && posY !== undefined ? { x: posX, y: posY } : {})
    });

    webview.once('tauri://error', (e) => {
      console.error('Markdown Editor Window creation error:', e);
    });

    console.log(`Markdown Editor 윈도우 시작됨: ${file.name} (${file.path})`);
  } catch (error) {
    console.error('마크다운 편집기를 열 수 없습니다:', error);
    await message(`마크다운 편집기를 열 수 없습니다: ${String(error)}`, {
      title: '오류',
      kind: 'error'
    });
  }
};
