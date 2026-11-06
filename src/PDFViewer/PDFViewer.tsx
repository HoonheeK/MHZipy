import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { message } from '@tauri-apps/plugin-dialog';

export interface PdfFile {
  path: string;
  name: string;
}

/**
 * Acrobat PDF 스타일의 별도 Modeless 인쇄 다이얼로그 윈도우를 엽니다.
 *
 * @param file 인쇄할 PDF 파일 정보 (경로 및 이름)
 * @param currentPage 현재 표시 중인 페이지 번호 (기본값: 1)
 * @param totalPages 전체 페이지 수 (기본값: 1)
 * @param storageId IndexedDB 캐시 키 (선택)
 */
export const openPdfPrintDialog = async (
  file: PdfFile,
  currentPage = 1,
  totalPages = 1,
  storageId = ''
) => {
  try {
    await invoke('open_pdf_print_dialog', {
      pdfPath: file.path,
      storageId,
      title: file.name,
      currentPage,
      totalPages,
      password: null,
    });
    return;
  } catch (err) {
    console.warn('invoke open_pdf_print_dialog fallback to WebviewWindow:', err);
  }

  const cleanKey = (file.path || file.name).replace(/[^a-zA-Z0-9-_]/g, '').slice(-32);
  const dialogLabel = `pdf-print-dialog-${cleanKey || 'default'}`;

  try {
    const existingWin = await WebviewWindow.getByLabel(dialogLabel);
    if (existingWin) {
      await existingWin.setFocus();
      return;
    }
  } catch (e) {}

  try {
    let posX: number | undefined;
    let posY: number | undefined;
    try {
      const currentWin = getCurrentWindow();
      const position = await currentWin.outerPosition();
      posX = position.x + 60;
      posY = position.y + 45;
    } catch (e) {}

    const url = `print-dialog.html?pdfPath=${encodeURIComponent(file.path)}&storageId=${encodeURIComponent(storageId)}&title=${encodeURIComponent(file.name)}&currentPage=${currentPage}&totalPages=${totalPages}`;
    const printWin = new WebviewWindow(dialogLabel, {
      url,
      title: `Print - ${file.name}`,
      width: 960,
      height: 710,
      minWidth: 820,
      minHeight: 580,
      decorations: false,
      resizable: true,
      ...(posX !== undefined && posY !== undefined ? { x: posX, y: posY } : {}),
    });

    printWin.once('tauri://error', (e) => {
      console.error('Print dialog window creation error:', e);
    });
  } catch (error) {
    console.error('인쇄 다이얼로그를 열 수 없습니다:', error);
    await message(`인쇄 다이얼로그를 열 수 없습니다: ${String(error)}`, {
      title: '인쇄 오류',
      kind: 'error',
    });
  }
};

/**
 * PDF 파일을 새 창에서 엽니다.
 * PDF 렌더링을 처리하는 `viewer.html`을 사용합니다.
 * 이 함수는 PDFWorker.tsx의 구현을 참고하여 작성되었습니다.
 *
 * @param file PDF 파일의 경로와 이름을 포함하는 객체.
 */
export const openPdfInWindow = async (file: PdfFile) => {
  const windowLabel = `pdf-viewer-${file.path.replace(/[^a-zA-Z0-9-_]/g, '')}`;

  try {
    const existingWin = await WebviewWindow.getByLabel(windowLabel);
    if (existingWin) {
      await existingWin.setFocus();
      return;
    }
  } catch (e) {
  }

  try {
    // 현재 창의 위치를 가져와서 같은 모니터에 새 창을 띄움
    let posX: number | undefined;
    let posY: number | undefined;
    try {
      const currentWin = getCurrentWindow();
      const position = await currentWin.outerPosition();
      posX = position.x + 50;
      posY = position.y + 50;
    } catch (e) {
      console.warn('현재 창 위치를 가져올 수 없습니다:', e);
    }

    const webview = new WebviewWindow(windowLabel, {
      url: `viewer.html?pdfPath=${encodeURIComponent(file.path)}&title=${encodeURIComponent(file.name)}`,
      title: file.name,
      width: 1100,
      height: 850,
      minWidth: 500,
      minHeight: 400,
      decorations: false,
      ...(posX !== undefined && posY !== undefined ? { x: posX, y: posY } : {})
    });

    webview.once('tauri://error', function (e) {
      console.error('Window creation error:', e);
    });

    console.log(`PDF 뷰어 윈도우 시작됨: ${file.name}`);
  } catch (error) {
    console.error('PDF 파일을 열 수 없습니다:', error);
    await message(`PDF 파일을 열 수 없습니다: ${String(error)}`, {
      title: '오류',
      kind: 'error'
    });
  }
};