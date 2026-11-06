import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MarkdownEditor from "./MarkdownEditor/MarkdownEditor";
import ImageViewer from "./ImageViewer/ImageViewer";
import VideoPlayer from "./VideoPlayer/VideoPlayer";
import PowerShellManager from "./PowerShellManager/PowerShellManager";
import "./i18n";

const params = new URLSearchParams(window.location.search);
const view = params.get('view');
const isMarkdownEditor = view === 'markdown-editor';
const isImageViewer = view === 'image-viewer';
const isVideoPlayer = view === 'video-player';
const isPowerShellManager = view === 'powershell-manager';
const filePath = params.get('filePath') || '';
const workingDir = params.get('workingDir') || '';
const scriptFilePath = params.get('scriptFilePath') || '';
const runnerMode = params.get('runnerMode') === '1';
const runId = params.get('runId') || '';

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
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
  </React.StrictMode>,
);

