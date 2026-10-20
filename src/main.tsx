import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MarkdownEditor from "./MarkdownEditor/MarkdownEditor";
import "./i18n";

const params = new URLSearchParams(window.location.search);
const isMarkdownEditor = params.get('view') === 'markdown-editor';
const filePath = params.get('filePath') || '';

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isMarkdownEditor ? <MarkdownEditor initialFilePath={filePath} /> : <App />}
  </React.StrictMode>,
);

