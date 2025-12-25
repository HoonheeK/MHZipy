import { rename } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { basename, sep } from '@tauri-apps/api/path';
import { copyRecursive, getUniquePath } from '../utils/fileOps';

export interface ClipboardItem {
  paths: string[];
  op: 'copy' | 'move';
}

export const checkPathPermission = (
  targetPath: string,
  editableFolders: string[] = [],
  readonlyFolders: string[] = []
): boolean => {
  let closestRule: { path: string; type: 'allow' | 'deny' } | null = null;

  for (const rule of editableFolders) {
    if (targetPath === rule || targetPath.startsWith(rule + '\\') || targetPath.startsWith(rule + '/')) {
      if (!closestRule || rule.length > closestRule.path.length) {
        closestRule = { path: rule, type: 'allow' };
      }
    }
  }

  for (const rule of readonlyFolders) {
    if (targetPath === rule || targetPath.startsWith(rule + '\\') || targetPath.startsWith(rule + '/')) {
      if (!closestRule || rule.length > closestRule.path.length) {
        closestRule = { path: rule, type: 'deny' };
      }
    }
  }

  return closestRule?.type === 'allow';
};

export const deleteFiles = async (paths: string[]): Promise<boolean> => {
  if (paths.length === 0) return false;
  
  const confirmed = await confirm(
    `${paths.length}개 항목을 휴지통으로 이동하시겠습니까?`,
    { title: '삭제 확인', kind: 'warning', okLabel: '예', cancelLabel: '아니오' }
  );

  if (confirmed) {
    try {
      await invoke('delete_to_trash', { paths });
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
  // Prevent copying/moving a folder into itself or a descendant.
  for (const srcPath of sourcePaths) {
    if (targetDir === srcPath) {
      const message = `폴더를 자기 자신 안으로 ${op === 'copy' ? '복사' : '이동'}할 수 없습니다.`;
      console.error(message);
      await confirm(message, { title: '잘못된 작업', kind: 'error' });
      return false;
    }

    const separator = sep();
    const srcWithSep = srcPath.endsWith(separator) ? srcPath : srcPath + separator;
    if (targetDir.startsWith(srcWithSep)) {
      const srcFolderName = await basename(srcPath);
      const message = `'${srcFolderName}' 폴더를 자신의 하위 폴더로 ${op === 'copy' ? '복사' : '이동'}할 수 없습니다.`;
      console.error(message);
      await confirm(message, { title: '잘못된 작업', kind: 'error' });
      return false;
    }
  }
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