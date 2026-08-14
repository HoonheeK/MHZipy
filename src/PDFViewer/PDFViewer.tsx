import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { message } from '@tauri-apps/plugin-dialog';
interface PdfFile {
  path: string;
  name: string;
}

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
    const webview = new WebviewWindow(windowLabel, {
      url: `viewer.html?pdfPath=${encodeURIComponent(file.path)}&title=${encodeURIComponent(file.name)}`,
      title: file.name,
      width: 1000,
      height: 800
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