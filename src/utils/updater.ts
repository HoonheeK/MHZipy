import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export async function checkForUpdates(
  manual: boolean,
  onAlert: (title: string, message: string) => void,
  onConfirm: (title: string, message: string, onYes: () => void) => void
) {
  try {
    const update = await check();
    if (update) {
      onConfirm(
        'Update Available',
        `Update to ${update.version} is available!\n\nRelease notes: ${update.body || 'No release notes provided.'}`,
        async () => {
          await update.downloadAndInstall();
          await relaunch();
        }
      );
    } else if (manual) {
      onAlert('No Updates', 'You are on the latest version.');
    }
  } catch (error) {
    console.error("Failed to check for updates:", error);
    if (manual) {
      onAlert('Update Error', `Failed to check for updates:\n${error}`);
    }
  }
}

