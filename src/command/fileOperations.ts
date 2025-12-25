import { remove, rename } from '@tauri-apps/plugin-fs';
import { confirm } from '@tauri-apps/plugin-dialog';
import { basename } from '@tauri-apps/api/path';
import { copyRecursive, getUniquePath } from '../utils/fileOps';

export interface ClipboardItem {
  paths: string[];
  op: 'copy' | 'move';
}

export const deleteFiles = async (paths: string[]): Promise<boolean> => {
  if (paths.length === 0) return false;
  
  const confirmed = await confirm(
    `${paths.length}개 항목을 삭제하시겠습니까?`,
    { title: '삭제 확인', kind: 'warning' }
  );

  if (confirmed) {
    try {
      for (const path of paths) {
        await remove(path, { recursive: true });
      }
      return true;
    } catch (error) {
      console.error('Delete failed:', error);
      return false;
    }
  }
  return false;
};

export const pasteFiles = async (
  sourcePaths: string[],
  targetDir: string,
  op: 'copy' | 'move'
): Promise<boolean> => {
  try {
    for (const srcPath of sourcePaths) {
      const srcName = await basename(srcPath);
      const destPath = await getUniquePath(targetDir, srcName);
      
      if (op === 'copy') {
        await copyRecursive(srcPath, destPath);
      } else {
        await rename(srcPath, destPath);
      }
    }
    return true;
  } catch (error) {
    console.error('Paste/Move failed:', error);
    return false;
  }
};