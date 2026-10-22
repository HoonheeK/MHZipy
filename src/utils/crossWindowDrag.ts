import { emit, listen, UnlistenFn } from '@tauri-apps/api/event';

/**
 * Cross-window drag & drop helper.
 *
 * Each Tauri window runs in its own WebView2 instance. When an HTML5 drag moves
 * from one window to another, custom MIME data (e.g. 'application/json') may not
 * survive the OLE transfer. To make it reliable, the drag source broadcasts its
 * payload to every window through a Tauri event, and the drop target falls back
 * to that shared payload when DataTransfer has no readable data.
 */

const DRAG_START_EVENT = 'mhz-drag-start';
const DRAG_END_EVENT = 'mhz-drag-end';

let sharedPayload: string | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;
let unlisteners: UnlistenFn[] = [];

/** Register listeners once per window (call at app startup). */
export async function initCrossWindowDrag(): Promise<void> {
  if (initialized) return;
  initialized = true;
  ensureExternalDropListener();
  try {
    unlisteners.push(
      await listen<string>(DRAG_START_EVENT, (event) => {
        if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
        sharedPayload = event.payload;
      })
    );
    unlisteners.push(
      await listen(DRAG_END_EVENT, () => {
        // Delay clearing so a drop handler in another window can still read it.
        if (clearTimer) clearTimeout(clearTimer);
        clearTimer = setTimeout(() => { sharedPayload = null; clearTimer = null; }, 1500);
      })
    );
  } catch (e) {
    console.warn('[crossWindowDrag] Failed to register listeners:', e);
  }
}

export function disposeCrossWindowDrag(): void {
  unlisteners.forEach((fn) => fn());
  unlisteners = [];
  initialized = false;
}

/** Call from onDragStart with the JSON string placed in DataTransfer. */
export function broadcastDragStart(payload: string): void {
  if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
  sharedPayload = payload;
  emit(DRAG_START_EVENT, payload).catch(() => {});
}

/** Call from onDragEnd of the drag source. */
export function broadcastDragEnd(): void {
  emit(DRAG_END_EVENT).catch(() => {});
}

/** Read drag payload: DataTransfer first, then the shared cross-window payload. */
export function getDragPayload(dt: DataTransfer | null | undefined): string | null {
  let data = '';
  try {
    data = dt?.getData('application/json') || '';
    if (!data) data = dt?.getData('text/plain') || '';
  } catch {
    data = '';
  }
  if (data) {
    // Only accept text/plain if it looks like our JSON payload
    const trimmed = data.trim();
    if (trimmed.startsWith('{')) return data;
  }
  return sharedPayload;
}

/** Clear the payload after a successful drop (and notify other windows). */
export function consumeDragPayload(): void {
  sharedPayload = null;
  broadcastDragEnd();
}

// ---------------------------------------------------------------------------
// Windows File Explorer <-> MHZipy (native drag & drop)
// ---------------------------------------------------------------------------

const EXTERNAL_DROP_MESSAGE = 'mhz-external-drop';
const EXTERNAL_DROP_EVENT = 'mhz-external-drop-paths';

/** True when running in WebView2 on Windows (native Shell drag available). */
export const isNativeDragSupported: boolean =
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent) &&
  typeof (window as any).chrome?.webview?.postMessageWithAdditionalObjects === 'function';

let pendingExternalResolve: ((paths: string[]) => void) | null = null;
let externalListenerReady: Promise<void> | null = null;

function ensureExternalDropListener(): Promise<void> {
  if (!externalListenerReady) {
    externalListenerReady = (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        await getCurrentWebview().listen<string[]>(EXTERNAL_DROP_EVENT, (event) => {
          const resolve = pendingExternalResolve;
          pendingExternalResolve = null;
          resolve?.(Array.isArray(event.payload) ? event.payload : []);
        });
      } catch (e) {
        console.warn('[crossWindowDrag] external drop listener failed:', e);
      }
    })();
  }
  return externalListenerReady;
}

/**
 * Convert files dropped from Windows Explorer (HTML5 File objects, no path)
 * into real file system paths through WebView2's postMessageWithAdditionalObjects.
 * Must be given the File list captured synchronously inside the drop event.
 */
export async function resolveExternalDropPaths(files: File[]): Promise<string[]> {
  const webview = (window as any).chrome?.webview;
  if (!files.length || typeof webview?.postMessageWithAdditionalObjects !== 'function') return [];
  await ensureExternalDropListener();
  return new Promise<string[]>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingExternalResolve === done) pendingExternalResolve = null;
      resolve([]);
    }, 5000);
    const done = (paths: string[]) => { clearTimeout(timer); resolve(paths); };
    pendingExternalResolve = done;
    webview.postMessageWithAdditionalObjects(EXTERNAL_DROP_MESSAGE, files);
  });
}

/**
 * Explorer-like default operation for files dropped from outside:
 * Ctrl = copy, Shift = move, otherwise move on the same drive / copy across drives.
 */
export function decideExternalDropOp(
  sourcePaths: string[], destDir: string, ctrlKey: boolean, shiftKey: boolean
): 'move' | 'copy' {
  if (ctrlKey) return 'copy';
  if (shiftKey) return 'move';
  const root = (p: string) => (p.match(/^([a-zA-Z]:|\\\\[^\\]+\\[^\\]+)/)?.[1] || '').toLowerCase();
  const destRoot = root(destDir);
  return sourcePaths.every((p) => root(p) === destRoot) ? 'move' : 'copy';
}

/**
 * Start a native Shell drag (so files can be dropped into Windows Explorer,
 * other MHZipy windows, or any app). Resolves when the drag loop ends.
 */
export async function startNativeFileDrag(paths: string[], payload: string): Promise<string | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  broadcastDragStart(payload); // internal/cross-window drops keep using the JSON payload
  try {
    return await invoke<string>('start_native_file_drag', { paths });
  } catch (e) {
    console.warn('[crossWindowDrag] native drag failed:', e);
    return null;
  } finally {
    broadcastDragEnd();
  }
}
