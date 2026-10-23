import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MarkdownEditor from "./MarkdownEditor/MarkdownEditor";
import ImageViewer from "./ImageViewer/ImageViewer";
import VideoPlayer from "./VideoPlayer/VideoPlayer";
import "./i18n";

const params = new URLSearchParams(window.location.search);
const view = params.get('view');
const isMarkdownEditor = view === 'markdown-editor';
const isImageViewer = view === 'image-viewer';
const isVideoPlayer = view === 'video-player';
const filePath = params.get('filePath') || '';

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isMarkdownEditor ? (
      <MarkdownEditor initialFilePath={filePath} />
    ) : isImageViewer ? (
      <ImageViewer initialFilePath={filePath} />
    ) : isVideoPlayer ? (
      <VideoPlayer initialFilePath={filePath} />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);

