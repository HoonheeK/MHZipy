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
  Edit3,
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

interface MarkdownEditorProps {
  initialFilePath?: string;
}

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({ initialFilePath }) => {
  const [filePath, setFilePath] = useState<string>(initialFilePath || '');
  const [content, setContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveNotification, setSaveNotification] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'split' | 'edit' | 'preview'>('split');
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [fontSize, setFontSize] = useState<number>(13);
  const [wordWrap, setWordWrap] = useState<boolean>(true);
  const [splitRatio, setSplitRatio] = useState<number>(50); // percentage for editor
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const [showConfirmClose, setShowConfirmClose] = useState<boolean>(false);
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number }>({ line: 1, col: 1 });

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
    // If no initialFilePath is passed, check query params
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
          setHistory([text]);
          setHistoryIndex(0);
        })
        .catch((err) => {
          console.error('Failed to read text file:', err);
          setContent(`// 파일 열기 실패: ${String(err)}`);
          setSavedContent(`// 파일 열기 실패: ${String(err)}`);
        })
        .finally(() => {
          setIsLoading(false);
        });
    } else {
      const defaultText = `# 새 문서\n\n여기에 마크다운을 작성하세요.`;
      setContent(defaultText);
      setSavedContent(defaultText);
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

  // Update history on content changes (debounced)
  const updateContentWithHistory = useCallback((newText: string) => {
    setContent(newText);
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
    }
  }, [historyIndex, history]);

  const handleRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIdx = historyIndex + 1;
      setHistoryIndex(newIdx);
      setContent(history[newIdx]);
    }
  }, [historyIndex, history]);

  // Save File
  const handleSave = useCallback(async () => {
    if (!filePath) return;
    setIsSaving(true);
    try {
      await invoke('save_text_file_content', { path: filePath, content });
      setSavedContent(content);
      setSaveNotification('저장 완료');
      setTimeout(() => setSaveNotification(null), 2500);
    } catch (err) {
      console.error('Failed to save file:', err);
      alert(`저장 중 오류가 발생했습니다: ${String(err)}`);
    } finally {
      setIsSaving(false);
    }
  }, [filePath, content]);

  // Text selection & insertion helper
  const insertText = useCallback((prefix: string, suffix: string = '', defaultText: string = '') => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = content.substring(start, end) || defaultText;

    const replacement = `${prefix}${selectedText}${suffix}`;
    const newContent = content.substring(0, start) + replacement + content.substring(end);

    updateContentWithHistory(newContent);

    // Reposition cursor
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(
        start + prefix.length,
        start + prefix.length + selectedText.length
      );
    }, 0);
  }, [content, updateContentWithHistory]);

  // Formatting Shortcuts & Key handling
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+S / Cmd+S
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      handleSave();
      return;
    }
    // Ctrl+Z
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      handleUndo();
      return;
    }
    // Ctrl+Y or Ctrl+Shift+Z
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      handleRedo();
      return;
    }
    // Ctrl+B (Bold)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      insertText('**', '**', '굵은 텍스트');
      return;
    }
    // Ctrl+I (Italic)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      insertText('*', '*', '기울임 텍스트');
      return;
    }
    // Ctrl+K (Link)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      insertText('[', '](https://)', '링크 텍스트');
      return;
    }
    // Tab key
    if (e.key === 'Tab') {
      e.preventDefault();
      insertText('  ', '', '');
      return;
    }
  }, [handleSave, handleUndo, handleRedo, insertText]);

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
    const lines = content.split('\n').length;
    const chars = content.length;
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    return { lines, chars, words };
  }, [content]);

  // Rendered HTML via marked
  const renderedHtml = useMemo(() => {
    if (!content.trim()) {
      return '<p style="color: #64748b; font-style: italic;">내용이 없습니다. 편집기에 마크다운을 입력하세요.</p>';
    }
    try {
      return marked.parse(content, { breaks: true, gfm: true }) as string;
    } catch (e) {
      return `<p style="color: #ef4444;">렌더링 에러: ${String(e)}</p>`;
    }
  }, [content]);

  // Line count for gutter
  const lineNumbersArray = useMemo(() => {
    const count = content.split('\n').length;
    return Array.from({ length: count }, (_, i) => i + 1);
  }, [content]);

  return (
    <div className="mhz-md-root">
      {/* 1. Custom Frameless Titlebar */}
      <div
        className="mhz-md-titlebar"
        data-tauri-drag-region
        onDoubleClick={handleToggleMaximize}
      >
        <div className="mhz-md-titlebar-left" data-tauri-drag-region>
          <div className="mhz-md-app-icon">
            <FileText size={17} />
          </div>
          <span className="mhz-md-title-filename">{fileName}</span>
          <span className={`mhz-md-status-badge ${isDirty ? 'dirty' : 'saved'}`}>
            {isDirty ? '● 저장되지 않음' : '✓ 저장됨'}
          </span>
          {saveNotification && (
            <span style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 600 }}>
              {saveNotification}
            </span>
          )}
        </div>

        <div className="mhz-md-titlebar-center" data-tauri-drag-region title={filePath}>
          {filePath}
        </div>

        <div className="mhz-md-titlebar-right">
          <button
            className="mhz-md-win-btn"
            onClick={handleMinimize}
            title="최소화"
          >
            <WindowMinIcon size={14} />
          </button>
          <button
            className="mhz-md-win-btn"
            onClick={handleToggleMaximize}
            title={isMaximized ? "이전 크기로 복원" : "최대화"}
          >
            {isMaximized ? <WindowRestoreIcon size={13} /> : <Square size={13} />}
          </button>
          <button
            className="mhz-md-win-btn close"
            onClick={handleCloseWindow}
            title="닫기"
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
            title="저장 (Ctrl+S)"
          >
            <Save size={14} />
            <span>저장</span>
            <kbd>Ctrl+S</kbd>
          </button>
          <div className="mhz-md-toolbar-sep" />
          <button
            className="mhz-md-tool-btn"
            onClick={handleUndo}
            disabled={historyIndex <= 0}
            title="실행 취소 (Ctrl+Z)"
          >
            <Undo2 size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={handleRedo}
            disabled={historyIndex >= history.length - 1}
            title="다시 실행 (Ctrl+Y)"
          >
            <Redo2 size={14} />
          </button>
        </div>

        <div className="mhz-md-toolbar-sep" />

        {/* Markdown Syntax Tools */}
        <div className="mhz-md-toolbar-group">
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('# ', '', '제목 1')}
            title="제목 1 (H1)"
          >
            <strong style={{ fontSize: '13px' }}>H1</strong>
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('## ', '', '제목 2')}
            title="제목 2 (H2)"
          >
            <strong style={{ fontSize: '13px' }}>H2</strong>
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('### ', '', '제목 3')}
            title="제목 3 (H3)"
          >
            <strong style={{ fontSize: '12px' }}>H3</strong>
          </button>
          <div className="mhz-md-toolbar-sep" />
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('**', '**', '굵은 텍스트')}
            title="굵게 (Ctrl+B)"
          >
            <Bold size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('*', '*', '기울임 텍스트')}
            title="기울임 (Ctrl+I)"
          >
            <Italic size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('~~', '~~', '취소선 텍스트')}
            title="취소선"
          >
            <Strikethrough size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('`', '`', '인라인 코드')}
            title="인라인 코드"
          >
            <Code size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('```\n', '\n```', '코드 블록 내용')}
            title="코드 블록"
          >
            <FileCode size={14} />
          </button>
          <div className="mhz-md-toolbar-sep" />
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('> ', '', '인용구')}
            title="인용문"
          >
            <Quote size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('- ', '', '목록 항목')}
            title="글머리 기호 목록"
          >
            <List size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('1. ', '', '번호 매기기 항목')}
            title="번호 매기기 목록"
          >
            <ListOrdered size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('- [ ] ', '', '할 일 항목')}
            title="체크리스트"
          >
            <CheckSquare size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('[', '](https://)', '링크 텍스트')}
            title="링크 삽입 (Ctrl+K)"
          >
            <LinkIcon size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('\n| 제목 1 | 제목 2 |\n| --- | --- |\n| 항목 1 | 항목 2 |\n')}
            title="표(Table) 삽입"
          >
            <Table size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => insertText('\n---\n')}
            title="구분선 삽입"
          >
            <Minus size={14} />
          </button>
        </div>

        <div className="mhz-md-toolbar-sep" />

        {/* View Mode & Editor Settings */}
        <div className="mhz-md-toolbar-group">
          <button
            className={`mhz-md-tool-btn ${viewMode === 'split' ? 'active' : ''}`}
            onClick={() => setViewMode('split')}
            title="분할 뷰 (편집기 + 미리보기)"
          >
            <Columns size={14} />
            <span>분할</span>
          </button>
          <button
            className={`mhz-md-tool-btn ${viewMode === 'edit' ? 'active' : ''}`}
            onClick={() => setViewMode('edit')}
            title="편집기 전용"
          >
            <Edit3 size={14} />
            <span>편집</span>
          </button>
          <button
            className={`mhz-md-tool-btn ${viewMode === 'preview' ? 'active' : ''}`}
            onClick={() => setViewMode('preview')}
            title="미리보기 전용"
          >
            <Eye size={14} />
            <span>미리보기</span>
          </button>
          <div className="mhz-md-toolbar-sep" />
          <button
            className={`mhz-md-tool-btn ${wordWrap ? 'active' : ''}`}
            onClick={() => setWordWrap(!wordWrap)}
            title="자동 줄바꿈 토글"
          >
            <WrapText size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => setFontSize(prev => Math.max(10, prev - 1))}
            title="글꼴 축소"
          >
            <ZoomOut size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => setFontSize(prev => Math.min(24, prev + 1))}
            title="글꼴 확대"
          >
            <ZoomIn size={14} />
          </button>
          <button
            className="mhz-md-tool-btn"
            onClick={() => {
              navigator.clipboard.writeText(content);
              setSaveNotification('마크다운 복사됨');
              setTimeout(() => setSaveNotification(null), 2000);
            }}
            title="전체 마크다운 복사"
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
            <span>파일을 불러오는 중...</span>
          </div>
        ) : (
          <>
            {/* Editor Pane */}
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

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                className={`mhz-md-textarea ${wordWrap ? 'wrap' : ''}`}
                style={{
                  fontSize: `${fontSize}px`,
                  lineHeight: 1.6
                }}
                value={content}
                onChange={(e) => updateContentWithHistory(e.target.value)}
                onKeyDown={handleKeyDown}
                onSelect={handleTextareaSelect}
                onKeyUp={handleTextareaSelect}
                onClick={handleTextareaSelect}
                onScroll={handleScroll}
                placeholder="마크다운 또는 일반 텍스트를 입력하세요..."
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
              <span>실시간 마크다운 미리보기</span>
              <span style={{ fontSize: '10px', color: '#475569' }}>GitHub Flavored Markdown</span>
            </div>
            <div
              ref={previewRef}
              className="mhz-md-preview-content"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
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
            줄 수: <strong>{stats.lines}</strong>
          </span>
          <span className="mhz-md-statusbar-item">
            단어 수: <strong>{stats.words}</strong>
          </span>
          <span className="mhz-md-statusbar-item">
            글자 수: <strong>{stats.chars}</strong>
          </span>
        </div>

        <div className="mhz-md-statusbar-right">
          <span className="mhz-md-statusbar-item">
            인코딩: <strong>UTF-8</strong>
          </span>
          <span className="mhz-md-statusbar-item">
            크기: <strong>{fontSize}px</strong>
          </span>
          <span className="mhz-md-statusbar-item">
            상태: <strong style={{ color: isDirty ? '#fbbf24' : '#34d399' }}>{isDirty ? '수정됨' : '저장됨'}</strong>
          </span>
        </div>
      </div>

      {/* 5. Unsaved Changes Confirmation Modal */}
      {showConfirmClose && (
        <div className="mhz-md-modal-backdrop">
          <div className="mhz-md-modal">
            <div className="mhz-md-modal-header">
              <AlertCircle size={20} color="#f59e0b" />
              <span>저장되지 않은 변경사항</span>
            </div>
            <div className="mhz-md-modal-body">
              <strong>'{fileName}'</strong> 파일의 변경 내용이 아직 저장되지 않았습니다.<br />
              종료하기 전에 변경 사항을 저장하시겠습니까?
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
                저장 후 닫기
              </button>
              <button
                className="mhz-md-modal-btn discard"
                onClick={() => {
                  setShowConfirmClose(false);
                  executeClose();
                }}
              >
                저장 안 함
              </button>
              <button
                className="mhz-md-modal-btn cancel"
                onClick={() => setShowConfirmClose(false)}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MarkdownEditor;
