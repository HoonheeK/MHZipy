import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import "./i18n";

const App = lazy(() => import("./App"));
const MarkdownEditor = lazy(() => import("./MarkdownEditor/MarkdownEditor"));
const ImageViewer = lazy(() => import("./ImageViewer/ImageViewer"));
const VideoPlayer = lazy(() => import("./VideoPlayer/VideoPlayer"));
const PowerShellManager = lazy(() => import("./PowerShellManager/PowerShellManager"));

const params = new URLSearchParams(window.location.search);
const view = params.get('view') || (window as any).__INITIAL_VIEW__;
const isMarkdownEditor = view === 'markdown-editor';
const isImageViewer = view === 'image-viewer';
const isVideoPlayer = view === 'video-player';
const isPowerShellManager = view === 'powershell-manager';
const filePath = params.get('filePath') || (window as any).__INITIAL_FILE_PATH__ || '';
const workingDir = params.get('workingDir') || (window as any).__INITIAL_WORKING_DIR__ || '';
const scriptFilePath = params.get('scriptFilePath') || (window as any).__INITIAL_SCRIPT_FILE_PATH__ || '';
const runnerMode = params.get('runnerMode') === '1' || !!(window as any).__INITIAL_RUNNER_MODE__;
const runId = params.get('runId') || (window as any).__INITIAL_RUN_ID__ || '';

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      {isMarkdownEditor ? (
        <MarkdownEditor initialFilePath={filePath} />
      ) : isImageViewer ? (
        <ImageViewer initialFilePath={filePath} />
      ) : isVideoPlayer ? (
        <VideoPlayer initialFilePath={filePath} />
      ) : isPowerShellManager ? (
        <PowerShellManager
          initialWorkingDir={workingDir}
          initialScriptFilePath={scriptFilePath}
          runnerMode={runnerMode}
          runId={runId}
        />
      ) : (
        <App />
      )}
    </Suspense>
  </React.StrictMode>,
);

