import { rename } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { basename, dirname, sep } from '@tauri-apps/api/path';
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
  // If no rules are defined at all, allow by default for better usability.
  if (editableFolders.length === 0 && readonlyFolders.length === 0) {
    return true;
  }

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
  
  try {
    await invoke('delete_to_trash', { paths });
    return true;
  } catch (error) {
    console.error('Delete failed:', error);
    return false;
  }
};

export const pasteFiles = async (
  sourcePaths: string[],
  targetDir: string,
  op: 'copy' | 'move'
): Promise<boolean> => {
  // Prevent copying/moving a folder into itself or a descendant.
  for (const srcPath of sourcePaths) {
    if (targetDir === srcPath) {
      const message = `Cannot ${op} a folder into itself.`;
      console.error(message);
      throw new Error(message);
    }

    const separator = sep();
    const srcWithSep = srcPath.endsWith(separator) ? srcPath : srcPath + separator;
    if (targetDir.startsWith(srcWithSep)) {
      const srcFolderName = await basename(srcPath);
      const message = `Cannot ${op} folder '${srcFolderName}' into its own subfolder.`;
      console.error(message);
      throw new Error(message);
    }
  }
  try {
    for (const srcPath of sourcePaths) {
      const srcName = await basename(srcPath);

      // 같은 폴더로 이동하는 경우 무시 (중복 이름 생성 방지)
      if (op === 'move') {
        const srcDir = await dirname(srcPath);
        if (srcDir === targetDir) continue;
      }

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