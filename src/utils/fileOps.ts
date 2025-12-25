import { exists, copyFile, mkdir, readDir, stat } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

export async function getUniquePath(dir: string, filename: string): Promise<string> {
  let newName = filename;
  let counter = 1;
  
  while (await exists(await join(dir, newName))) {
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex !== -1) {
        const base = filename.substring(0, dotIndex);
        const extension = filename.substring(dotIndex);
        newName = `${base}_${counter}${extension}`;
    } else {
        newName = `${filename}_${counter}`;
    }
    counter++;
  }
  return join(dir, newName);
}

export async function copyRecursive(source: string, target: string) {
  const stats = await stat(source);
  if (stats.isDirectory) {
    await mkdir(target, { recursive: true });
    const entries = await readDir(source);
    for (const entry of entries) {
      await copyRecursive(await join(source, entry.name), await join(target, entry.name));
    }
  } else {
    await copyFile(source, target);
  }
}
