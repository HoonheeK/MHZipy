import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { message } from '@tauri-apps/plugin-dialog';
import { readFile as readBinaryFile } from '@tauri-apps/plugin-fs';
import { saveToIndexedDB } from '../utils/indexedDB';

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
  // 중복 방지 및 포커싱을 위해 창에 고유한 레이블을 생성합니다.
  // 레이블은 영숫자와 `-`, `_`, `/`만 포함할 수 있습니다.
  const windowLabel = `pdf-viewer-${file.path.replace(/[^a-zA-Z0-9-_/]/g, '')}`;

  // 이 레이블을 가진 창이 이미 있는지 확인합니다.
  try {
    // WebviewWindow.getByLabel이 Promise를 반환하므로 await을 사용해야 합니다.
    const existingWin = await WebviewWindow.getByLabel(windowLabel);
    if (existingWin) {
      // 창이 존재하면 포커스를 맞추고 앞으로 가져옵니다.
      await existingWin.setFocus();
      return;
    }
  } catch (e) {
    // getByLabel이 창을 찾지 못했을 때 에러를 던지는 경우(Tauri v1 동작) 또는
    // 다른 예기치 않은 오류가 발생한 경우, 창 생성을 계속 진행합니다.
  }

  try {
    // 1. 파일 내용을 바이너리로 읽습니다.
    // asset protocol은 새 창에서 보안상의 이유로 접근이 거부될 수 있으므로,
    // 파일 내용을 직접 읽어 IndexedDB를 통해 전달하는 안정적인 방식을 사용합니다.
    const fileContents = await readBinaryFile(file.path);

    // 2. 고유 ID를 생성하고 IndexedDB에 저장합니다.
    // viewer.html은 이 ID를 사용해 파일 데이터에 접근합니다.
    const storageId = `file-${Date.now()}-${Math.random()}`;
    await saveToIndexedDB(storageId, fileContents);

    // 3. storageId를 사용하여 뷰어 URL을 구성합니다.
    const viewerUrl = `/viewer.html?storageId=${encodeURIComponent(storageId)}&title=${encodeURIComponent(file.name)}`;

    // 4. 새 웹뷰 창을 생성합니다.
    const webview = new WebviewWindow(windowLabel, {
      url: viewerUrl,
      title: file.name,
      width: 1000,
      height: 800,
      resizable: true,
    });

    webview.once('tauri://created', () => {
      console.log(`PDF 뷰어 창 생성됨: ${file.name}`);
    });

    webview.once('tauri://error', (e) => {
      console.error('PDF 뷰어 창 생성 실패:', e);
      message(`PDF 뷰어 창을 여는 데 실패했습니다: ${e.payload}`, {
        title: '오류',
        kind: 'error'
      });
    });
  } catch (error) {
    console.error('PDF 파일을 열 수 없습니다:', error);
    await message(`PDF 파일을 열 수 없습니다: ${String(error)}`, {
      title: '오류',
      kind: 'error'
    });
  }
};