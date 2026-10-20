import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { marked } from 'marked';
import {
  FileText,
  Save,
  Undo2,
  Redo2,
  Bold,
  Italic,
  Strikethrough,
  Code,
  FileCode,
  Quote,
  List,
  ListOrdered,
  CheckSquare,
  Link as LinkIcon,
  Table,
  Minus,
  Columns,
  Eye,
  Code2,
  PenTool,
  Copy,
  WrapText,
  ZoomIn,
  ZoomOut,
  X,
  Square,
  Minus as WindowMinIcon,
  Copy as WindowRestoreIcon,
  AlertCircle
} from 'lucide-react';
import './MarkdownEditor.css';

import { Block, parseMarkdownToBlocks, serializeBlocksToMarkdown } from './markdownBlockUtils';
import { TreeEditableCell } from './TreeEditableCell';

interface MarkdownEditorProps {
  initialFilePath?: string;
}

/**
 * Robust markdown renderer with GFM and formatting normalization.
 * Handles - **ABC**, **bold**, lists, and tables seamlessly.
 */
const renderMarkdown = (text: string): string => {
  if (!text || !text.trim()) return '';
  // Normalize hyphen without space before bold: '-**' -> '- **'
  let normalized = text.replace(/^-(\*\*|__)/gm, '- $1');
  // Normalize spaces inside bold asterisks: '** foo **' -> '**foo**'
  normalized = normalized.replace(/\*\*\s+([^\s*](?:[\s\S]*?[^\s*])?)\s+\*\*/g, '**$1**');
  try {
    return marked.parse(normalized, { breaks: true, gfm: true }) as string;
  } catch {
    return marked.parse(text, { breaks: true, gfm: true }) as string;
  }
};

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({ initialFilePath }) => {
  const [filePath, setFilePath] = useState<string>(initialFilePath || '');
  const [content, setContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveNotification, setSaveNotification] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'wysiwyg' | 'split' | 'edit' | 'preview'>('wysiwyg');
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [fontSize, setFontSize] = useState<number>(13);
  const [wordWrap, setWordWrap] = useState<boolean>(true);
  const [splitRatio, setSplitRatio] = useState<number>(50); // percentage for editor
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const [showConfirmClose, setShowConfirmClose] = useState<boolean>(false);
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number }>({ line: 1, col: 1 });

  // WYSIWYG Block/Cell Editing states (Inspired by TreeDiadev's EditableCell)
  const [blocks, setBlocks] = useState<Block[]>(() => parseMarkdownToBlocks(''));

  // Undo / Redo history
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const fileName = useMemo(() => {
    if (!filePath) return 'Untitled.md';
    return filePath.split(/[/\\]/).pop() || 'Untitled.md';
  }, [filePath]);

  const isDirty = useMemo(() => {
    return content !== savedContent;
  }, [content, savedContent]);

  // Load File Content on Mount
  useEffect(() => {
    let targetPath = initialFilePath;
    if (!targetPath) {
      const params = new URLSearchParams(window.location.search);
      targetPath = params.get('filePath') || '';
    }

    if (targetPath) {
      setFilePath(targetPath);
      setIsLoading(true);

      invoke<string>('read_text_file_content', { path: targetPath })
        .then((text) => {
          setContent(text);
          setSavedContent(text);
          setBlocks(parseMarkdownToBlocks(text));
          setHistory([text]);
          setHistoryIndex(0);
        })
        .catch((err) => {
          console.error('Failed to read text file:', err);
          const errorMsg = `// Failed to open file: ${String(err)}`;
          setContent(errorMsg);
          setSavedContent(errorMsg);
          setBlocks(parseMarkdownToBlocks(errorMsg));
        })
        .finally(() => {
          setIsLoading(false);
        });
    } else {
      const defaultText = `# Welcome\n\nStart typing markdown or text here.`;
      setContent(defaultText);
      setSavedContent(defaultText);
      setBlocks(parseMarkdownToBlocks(defaultText));
      setHistory([defaultText]);
      setHistoryIndex(0);
      setIsLoading(false);
    }
  }, [initialFilePath]);

  // Sync Maximize state
  useEffect(() => {
    const checkMax = async () => {
      try {
        const max = await invoke<boolean>('is_window_maximized');
        setIsMaximized(max);
      } catch {
        try {
          const win = getCurrentWindow();
          setIsMaximized(await win.isMaximized());
        } catch {}
      }
    };
    checkMax();

    let unlisten: (() => void) | undefined;
    getCurrentWindow().onResized(() => {
      checkMax();
    }).then(u => { unlisten = u; });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Update blocks from TreeEditableCell
  const handleUpdateBlocks = useCallback((newBlocks: Block[]) => {
    setBlocks(newBlocks);
    const serialized = serializeBlocksToMarkdown(newBlocks);
    setContent(serialized);
  }, []);

  // Sync Blocks when switching to WYSIWYG mode
  const handleSwitchToWysiwyg = () => {
    setBlocks(parseMarkdownToBlocks(content));
    setViewMode('wysiwyg');
  };

  // Sync Raw Content when switching from WYSIWYG mode
  const handleSwitchFromWysiwyg = (targetMode: 'split' | 'edit' | 'preview') => {
    const newContent = serializeBlocksToMarkdown(blocks);
    setContent(newContent);
    setViewMode(targetMode);
  };

  // Update history on content changes
  const updateContentWithHistory = useCallback((newText: string) => {
    setContent(newText);
    setBlocks(parseMarkdownToBlocks(newText));
    setHistory(prev => {
      const sliced = prev.slice(0, historyIndex + 1);
      return [...sliced, newText];
    });
    setHistoryIndex(prev => prev + 1);
  }, [historyIndex]);

  // Undo / Redo
  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      const newIdx = historyIndex - 1;
      setHistoryIndex(newIdx);
      setContent(history[newIdx]);
      setBlocks(parseMarkdownToBlocks(history[newIdx]));
    }
  }, [historyIndex, history]);

  const handleRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIdx = historyIndex + 1;
      setHistoryIndex(newIdx);
      setContent(history[newIdx]);
      setBlocks(parseMarkdownToBlocks(history[newIdx]));
    }
  }, [historyIndex, history]);

  // Save File
  const handleSave = useCallback(async () => {
    if (!filePath) return;
    setIsSaving(true);
    try {
      const textToSave = viewMode === 'wysiwyg' ? serializeBlocksToMarkdown(blocks) : content;
      await invoke('save_text_file_content', { path: filePath, content: textToSave });
      setSavedContent(textToSave);
      setContent(textToSave);
      setSaveNotification('Saved');
      setTimeout(() => setSaveNotification(null), 2500);
    } catch (err) {
      console.error('Failed to save file:', err);
      alert(`Save error: ${String(err)}`);
    } finally {
      setIsSaving(false);
    }
  }, [filePath, content, viewMode, blocks]);

  // Text selection & insertion helper for raw textarea or toolbar actions
  const insertText = useCallback((prefix: string, suffix: string = '', defaultText: string = '') => {
    if (viewMode === 'wysiwyg') {
      const updated = content ? `${content}\n${prefix}${defaultText}${suffix}` : `${prefix}${defaultText}${suffix}`;
      setContent(updated);
      setBlocks(parseMarkdownToBlocks(updated));
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = content.substring(start, end) || defaultText;

    const replacement = `${prefix}${selectedText}${suffix}`;
    const newContent = content.substring(0, start) + replacement + content.substring(end);

    updateContentWithHistory(newContent);

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(
        start + prefix.length,
        start + prefix.length + selectedText.length
      );
    }, 0);
  }, [content, viewMode, updateContentWithHistory]);

  // Global Keydown Handler (Save shortcut)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Ctrl+S / Cmd+S
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSave();
        return;
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handleSave]);

  // Textarea Shortcuts in Source mode
  const handleSourceKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      handleUndo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      handleRedo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      insertText('**', '**', 'bold text');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      insertText('*', '*', 'italic text');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      insertText('[', '](https://)', 'link text');
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      insertText('  ', '', '');
      return;
    }
  };

  // Cursor position tracking
  const handleTextareaSelect = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const textBeforeCursor = content.substring(0, textarea.selectionStart);
    const lines = textBeforeCursor.split('\n');
    setCursorPos({
      line: lines.length,
      col: lines[lines.length - 1].length + 1
    });
  };

  // Synchronize Line Number scroll
  const handleScroll = () => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Window Drag Handler (Robust Webview dragging for Windows)
  const handleTitlebarMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0 && !(e.target as HTMLElement).closest('button, input, select, a, .mhz-md-status-badge')) {
      try {
        getCurrentWindow().startDragging();
      } catch (err) {
        console.warn('startDragging error:', err);
      }
    }
  };

  // Window Controls
  const handleMinimize = async () => {
    try {
      await invoke('minimize_window');
    } catch {
      getCurrentWindow().minimize();
    }
  };

  const handleToggleMaximize = async () => {
    try {
      const newMax = await invoke<boolean>('toggle_maximize');
      setIsMaximized(newMax);
    } catch {
      const win = getCurrentWindow();
      await win.toggleMaximize();
      setIsMaximized(await win.isMaximized());
    }
  };

  const handleCloseWindow = async () => {
    if (isDirty) {
      setShowConfirmClose(true);
    } else {
      executeClose();
    }
  };

  const executeClose = async () => {
    try {
      await invoke('close_window');
    } catch {
      getCurrentWindow().close();
    }
  };

  // Split Divider Dragging
  const handleMouseDownResizer = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const totalWidth = window.innerWidth;
      const newRatio = Math.max(20, Math.min(80, (e.clientX / totalWidth) * 100));
      setSplitRatio(newRatio);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Statistics
  const stats = useMemo(() => {
    const text = viewMode === 'wysiwyg' ? serializeBlocksToMarkdown(blocks) : content;
    const lines = text.split('\n').length;
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return { lines, chars, words };
  }, [content, blocks, viewMode]);

  // Rendered preview HTML for Split or Preview mode
  const renderedFullHtml = useMemo(() => {
    const text = viewMode === 'wysiwyg' ? serializeBlocksToMarkdown(blocks) : content;
    if (!text.trim()) {
      return '';
    }
    try {
      return renderMarkdown(text);
    } catch (e) {
      return `<p style="color: #ef4444;">Rendering Error: ${String(e)}</p>`;
    }
  }, [content, blocks, viewMode]);

  // Line count for gutter
  const lineNumbersArray = useMemo(() => {
    const count = content.split('\n').length;
    return Array.from({ length: count }, (_, i) => i + 1);
  }, [content]);

  return (
    <div className="mhz-md-root">
      {/* 1. Custom Frameless Titlebar with Window Dragging */}
      <div
        className="mhz-md-titlebar"
        data-tauri-drag-region
        onMouseDown={handleTitlebarMouseDown}
        onDoubleClick={handleToggleMaximize}
      >
        <div className="mhz-md-titlebar-left" data-tauri-drag-region>
          <div className="mhz-md-app-icon">
            <FileText size={17} />
          </div>
          <span className="mhz-md-title-filename">{fileName}</span>
          <span className={`mhz-md-status-badge ${isDirty ? 'dirty' : 'saved'}`}>
            {isDirty ? '● Unsaved' : '✓ Saved'}
          </span>
          {saveNotification && (
            <span style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 600 }}>
              {saveNotification}
            </span>
          )}
        </div>

        <div
          className="mhz-md-titlebar-center"
          data-tauri-drag-region
          onMouseDown={handleTitlebarMouseDown}
          onDoubleClick={handleToggleMaximize}
          title="Drag to move window, double-click to toggle maximize"
        >
          {filePath}
        </div>

        <div className="mhz-md-titlebar-right">
          <button
            className="mhz-md-win-btn"
            onClick={handleMinimize}
            title="Minimize"
          >
            <WindowMinIcon size={14} />
          </button>
          <button
            className="mhz-md-win-btn"
            onClick={handleToggleMaximize}
            title={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? <WindowRestoreIcon size={13} /> : <Square size={13} />}
          </button>
          <button
            className="mhz-md-win-btn close"
            onClick={handleCloseWindow}
            title="Close"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* 2. Top Action Toolbar */}
      <div className="mhz-md-toolbar">
        {/* File & History */}
        <div className="mhz-md-toolbar-group">
          <button
            className={`mhz-md-tool-btn primary ${isDirty ? 'has-changes' : ''}`}
            onClick={handleSave}
            disabled={isSaving}
            title="Save (Ctrl+S)"
          >
            <Save size={14} />
            <span>Save</span>
            <kbd>Ctrl+S</kbd>
          </button>
          <div className="mhz-md-toolbar-sep" />
          <button
            className="mhz-md-tool-btn"
            onClick={handleUndo}
            disabled={historyIndex <= 0}
            title="Undo (Ctrl+Z)"
          >
            <Undo2 size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={handleRedo}
            disabled={historyIndex >= history.length - 1}
            title="Redo (Ctrl+Y)"
          >
            <Redo2 size={14} />
          </button>
        </div>

        <div className="mhz-md-toolbar-sep" />

        {/* Markdown & Cell Formatting Tools */}
        <div className="mhz-md-toolbar-group">
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('# ', '', 'Heading 1')}
            title="Heading 1 (H1)"
          >
            <strong style={{ fontSize: '13px' }}>H1</strong>
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('## ', '', 'Heading 2')}
            title="Heading 2 (H2)"
          >
            <strong style={{ fontSize: '13px' }}>H2</strong>
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('### ', '', 'Heading 3')}
            title="Heading 3 (H3)"
          >
            <strong style={{ fontSize: '12px' }}>H3</strong>
          </button>
          <div className="mhz-md-toolbar-sep" />
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('**', '**', 'bold text')}
            title="Bold (Ctrl+B)"
          >
            <Bold size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('*', '*', 'italic text')}
            title="Italic (Ctrl+I)"
          >
            <Italic size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('~~', '~~', 'strikethrough text')}
            title="Strikethrough"
          >
            <Strikethrough size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('`', '`', 'inline code')}
            title="Inline Code"
          >
            <Code size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('```\n', '\n```', 'code block')}
            title="Code Block"
          >
            <FileCode size={14} />
          </button>
          <div className="mhz-md-toolbar-sep" />
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('> ', '', 'quote')}
            title="Blockquote"
          >
            <Quote size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('- ', '', 'list item')}
            title="Bullet List"
          >
            <List size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('1. ', '', 'numbered item')}
            title="Numbered List"
          >
            <ListOrdered size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('- [ ] ', '', 'task item')}
            title="Task Checklist"
          >
            <CheckSquare size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('[', '](https://)', 'link text')}
            title="Insert Link (Ctrl+K)"
          >
            <LinkIcon size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('\n| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n')}
            title="Insert Table"
          >
            <Table size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('\n---\n')}
            title="Horizontal Rule"
          >
            <Minus size={14} />
          </button>
        </div>

        <div className="mhz-md-toolbar-sep" />

        {/* View Mode & Editor Settings */}
        <div className="mhz-md-toolbar-group">
          <button
            className={`mhz-md-tool-btn ${viewMode === 'wysiwyg' ? 'active' : ''}`}
            onClick={handleSwitchToWysiwyg}
            title="WYSIWYG Cell Mode (Editable Blocks with F2)"
          >
            <PenTool size={14} />
            <span>WYSIWYG</span>
          </button>
          <button
            className={`mhz-md-tool-btn ${viewMode === 'split' ? 'active' : ''}`}
            onClick={() => handleSwitchFromWysiwyg('split')}
            title="Split View (Source + Preview)"
          >
            <Columns size={14} />
            <span>Split</span>
          </button>
          <button
            className={`mhz-md-tool-btn ${viewMode === 'edit' ? 'active' : ''}`}
            onClick={() => handleSwitchFromWysiwyg('edit')}
            title="Source Code Only"
          >
            <Code2 size={14} />
            <span>Source</span>
          </button>
          <button
            className={`mhz-md-tool-btn ${viewMode === 'preview' ? 'active' : ''}`}
            onClick={() => handleSwitchFromWysiwyg('preview')}
            title="Preview Only"
          >
            <Eye size={14} />
            <span>Preview</span>
          </button>
          <div className="mhz-md-toolbar-sep" />
          <button
            className={`mhz-md-tool-btn ${wordWrap ? 'active' : ''}`}
            onClick={() => setWordWrap(!wordWrap)}
            title="Toggle Word Wrap"
          >
            <WrapText size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => setFontSize(prev => Math.max(10, prev - 1))}
            title="Decrease Font Size"
          >
            <ZoomOut size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => setFontSize(prev => Math.min(24, prev + 1))}
            title="Increase Font Size"
          >
            <ZoomIn size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => {
              const textToCopy = viewMode === 'wysiwyg' ? serializeBlocksToMarkdown(blocks) : content;
              navigator.clipboard.writeText(textToCopy);
              setSaveNotification('Markdown copied');
              setTimeout(() => setSaveNotification(null), 2000);
            }}
            title="Copy Markdown to Clipboard"
          >
            <Copy size={14} />
          </button>
        </div>
      </div>

      {/* 3. Main Body */}
      <div className="mhz-md-body">
        {isLoading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', gap: '8px' }}>
            <FileText size={18} className="animate-spin" />
            <span>Loading file...</span>
          </div>
        ) : (
          <>
            {/* WYSIWYG Mode Pane with TreeDiadev-inspired TreeEditableCell */}
            {viewMode === 'wysiwyg' && (
              <div className="mhz-md-pane wysiwyg-pane">
                <TreeEditableCell
                  blocks={blocks}
                  onUpdateBlocks={handleUpdateBlocks}
                  fontSize={fontSize}
                />
              </div>
            )}

            {/* Split or Source Code Pane */}
            {(viewMode === 'split' || viewMode === 'edit') && (
              <div
                className="mhz-md-pane editor-pane"
                style={{ width: viewMode === 'split' ? `${splitRatio}%` : '100%' }}
              >
                <div className="mhz-md-editor-container">
                  {/* Line Numbers */}
                  <div
                    ref={lineNumbersRef}
                    className="mhz-md-line-numbers"
                    style={{ fontSize: `${fontSize}px` }}
                  >
                    {lineNumbersArray.map((lineNum) => (
                      <div key={lineNum} style={{ height: `${fontSize * 1.6}px` }}>
                        {lineNum}
                      </div>
                    ))}
                  </div>

                  {/* Raw Textarea */}
                  <textarea
                    ref={textareaRef}
                    className={`mhz-md-textarea ${wordWrap ? 'wrap' : ''}`}
                    style={{
                      fontSize: `${fontSize}px`,
                      lineHeight: 1.6
                    }}
                    value={content}
                    onChange={(e) => updateContentWithHistory(e.target.value)}
                    onKeyDown={handleSourceKeyDown}
                    onSelect={handleTextareaSelect}
                    onKeyUp={handleTextareaSelect}
                    onClick={handleTextareaSelect}
                    onScroll={handleScroll}
                    placeholder="Start typing markdown or text here..."
                    spellCheck={false}
                    autoFocus
                  />
                </div>
              </div>
            )}

            {/* Resizer Divider */}
            {viewMode === 'split' && (
              <div
                className={`mhz-md-resizer ${isResizing ? 'resizing' : ''}`}
                onMouseDown={handleMouseDownResizer}
              />
            )}

            {/* Preview Pane */}
            {(viewMode === 'split' || viewMode === 'preview') && (
              <div
                className="mhz-md-pane preview-pane"
                style={{ width: viewMode === 'split' ? `${100 - splitRatio}%` : '100%' }}
              >
                <div className="mhz-md-preview-header">
                  <span>Live Markdown Preview</span>
                  <span style={{ fontSize: '10px', color: '#475569' }}>GitHub Flavored Markdown</span>
                </div>
                <div
                  ref={previewRef}
                  className="mhz-md-preview-content"
                  style={{ fontSize: `${fontSize}px` }}
                  dangerouslySetInnerHTML={{ __html: renderedFullHtml || '<p style="color: #64748b; font-style: italic;">No content to preview.</p>' }}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* 4. Bottom Status Bar */}
      <div className="mhz-md-statusbar">
        <div className="mhz-md-statusbar-left">
          <span className="mhz-md-statusbar-item">
            Ln <strong>{cursorPos.line}</strong>, Col <strong>{cursorPos.col}</strong>
          </span>
          <span className="mhz-md-statusbar-item">
            Lines: <strong>{stats.lines}</strong>
          </span>
          <span className="mhz-md-statusbar-item">
            Words: <strong>{stats.words}</strong>
          </span>
          <span className="mhz-md-statusbar-item">
            Characters: <strong>{stats.chars}</strong>
          </span>
          {viewMode === 'wysiwyg' && (
            <span className="mhz-md-statusbar-item">
              Cells: <strong>{blocks.length}</strong>
            </span>
          )}
        </div>

        <div className="mhz-md-statusbar-right">
          <span className="mhz-md-statusbar-item">
            Encoding: <strong>UTF-8</strong>
          </span>
          <span className="mhz-md-statusbar-item">
            Font: <strong>{fontSize}px</strong>
          </span>
          <span className="mhz-md-statusbar-item">
            Status: <strong style={{ color: isDirty ? '#fbbf24' : '#34d399' }}>{isDirty ? 'Modified' : 'Saved'}</strong>
          </span>
        </div>
      </div>

      {/* 5. Unsaved Changes Confirmation Modal */}
      {showConfirmClose && (
        <div className="mhz-md-modal-backdrop">
          <div className="mhz-md-modal">
            <div className="mhz-md-modal-header">
              <AlertCircle size={20} color="#f59e0b" />
              <span>Unsaved Changes</span>
            </div>
            <div className="mhz-md-modal-body">
              Do you want to save the changes you made to <strong>'{fileName}'</strong>?<br />
              Your changes will be lost if you close without saving.
            </div>
            <div className="mhz-md-modal-actions">
              <button
                className="mhz-md-modal-btn save"
                onClick={async () => {
                  await handleSave();
                  setShowConfirmClose(false);
                  executeClose();
                }}
              >
                Save & Close
              </button>
              <button
                className="mhz-md-modal-btn discard"
                onClick={() => {
                  setShowConfirmClose(false);
                  executeClose();
                }}
              >
                Don't Save
              </button>
              <button
                className="mhz-md-modal-btn cancel"
                onClick={() => setShowConfirmClose(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MarkdownEditor;
