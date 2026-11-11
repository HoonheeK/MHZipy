import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit } from '@tauri-apps/api/event';
import { rename, writeFile, copyFile, exists } from '@tauri-apps/plugin-fs';
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
  ClipboardCopy,
  ClipboardCheck,
  WrapText,
  X,
  Square,
  Minus as WindowMinIcon,
  Copy as WindowRestoreIcon,
  AlertCircle,
  Search,
  RotateCw,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  Folder,
  Edit3,
  Sparkles,
  Sliders,
  ListTree
} from 'lucide-react';
import './MarkdownEditor.css';

import { Block, BlockType, generateId, parseMarkdownToBlocks, serializeBlocksToMarkdown, renderImageHtml } from './markdownBlockUtils';
import { TreeEditableCell } from './TreeEditableCell';
import {
  MdToTextRules,
  loadSavedRules,
  convertBlocksToPlainText,
  convertMarkdownToPlainText
} from './mdToTextConverter';
import { MdToTextRulesModal } from './MdToTextRulesModal';
import {
  PatternRule,
  loadStoredReverseRules,
  shouldShowIngestionModal,
  parseTextToBlocksWithRules,
} from './textToMdScanner';
import { TextToMdIngestionModal } from './TextToMdIngestionModal';

interface MarkdownEditorProps {
  initialFilePath?: string;
}

/**
 * Robust markdown renderer with GFM and formatting normalization.
 * Handles - **ABC**, **bold**, lists, and tables seamlessly.
 */
const renderMarkdown = (text: string, baseDir?: string): string => {
  if (!text || !text.trim()) return '';
  // 1. Normalize line endings (CRLF / CR -> LF) for Windows & textarea compatibility
  let normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 2. Normalize hyphen without space before bold: '-**' -> '- **'
  normalized = normalized.replace(/^-(\*\*|__)/gm, '- $1');
  // 3. Normalize spaces inside bold asterisks: '** foo **' -> '**foo**'
  normalized = normalized.replace(/\*\*\s+([^\s*](?:[\s\S]*?[^\s*])?)\s+\*\*/g, '**$1**');
  // 4. Prevent Setext heading misinterpretation:
  // When '---', '***', '___', or '===' immediately follows text without an empty line (and optional trailing whitespace),
  // standard CommonMark/marked parser treats the preceding text as <h2> or <h1>.
  // Automatically insert a blank line so it renders properly as a paragraph + horizontal rule (<hr>).
  normalized = normalized.replace(/([^\n])\n\s*(-{3,}|\*{3,}|_{3,}|={3,})\s*(?=\n|$)/g, '$1\n\n$2');
  let html = '';
  try {
    html = marked.parse(normalized, { breaks: true, gfm: true }) as string;
  } catch {
    html = marked.parse(normalized, { breaks: true, gfm: true }) as string;
  }
  if (html.includes('<img')) {
    html = html.replace(/<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi, (_match, prefix, src, suffix) => {
      const altMatch = (prefix + suffix).match(/alt=["']([^"']*)["']/i);
      const titleMatch = (prefix + suffix).match(/title=["']([^"']*)["']/i);
      const alt = altMatch ? altMatch[1] : '';
      const title = titleMatch ? titleMatch[1] : '';
      return renderImageHtml(src, alt, title, baseDir);
    });
  }
  return html;
};

const isTextNonMarkdown = (path: string): boolean => {
  if (!path) return false;
  const ext = path.toLowerCase().split('.').pop() || '';
  return ext !== 'md' && ext !== 'markdown';
};

export interface EncodingOption {
  label: string;
  name: string;
  description: string;
}

export const SUPPORTED_ENCODINGS: EncodingOption[] = [
  { label: 'UTF-8', name: 'UTF-8', description: 'Universal (Standard Unicode)' },
  { label: 'UTF-8 with BOM', name: 'UTF-8 with BOM', description: 'Universal (Windows Signature)' },
  { label: 'EUC-KR (CP949)', name: 'EUC-KR', description: 'Korean (한국어 완성형 / 통합 완성형)' },
  { label: 'Shift-JIS', name: 'Shift_JIS', description: 'Japanese (일본어)' },
  { label: 'GBK / GB18030', name: 'GBK', description: 'Simplified Chinese (중국어 간체)' },
  { label: 'Big5', name: 'Big5', description: 'Traditional Chinese (중국어 번체)' },
  { label: 'UTF-16 LE', name: 'UTF-16 LE', description: 'Unicode 16-bit (Little Endian)' },
  { label: 'UTF-16 BE', name: 'UTF-16 BE', description: 'Unicode 16-bit (Big Endian)' },
  { label: 'Windows-1252', name: 'windows-1252', description: 'Western European' },
  { label: 'Windows-1251', name: 'windows-1251', description: 'Cyrillic (러시아어/키릴)' },
];

export const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30, 32];

export interface HistoryItem {
  content: string;
  blocks: Block[];
}

export interface TocItem {
  id: string;
  text: string;
  level: number;
  lineIndex?: number;
  blockId?: string;
}

const isBlockStructuralChange = (prev: Block[], next: Block[]): boolean => {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    const p = prev[i];
    const n = next[i];
    if (p.id !== n.id) return true;
    if (p.type !== n.type) return true;
    if (p.indent !== n.indent) return true;
    if (p.checked !== n.checked) return true;
    if (p.listType !== n.listType) return true;
    if (p.isRaw !== n.isRaw) return true;
    if (Math.abs((p.html || '').length - (n.html || '').length) > 10) return true;
  }
  return false;
};

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({ initialFilePath }) => {
  const [filePath, setFilePath] = useState<string>(initialFilePath || '');
  const [content, setContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveNotification, setSaveNotification] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'wysiwyg' | 'split' | 'edit' | 'preview'>(() => {
    const params = new URLSearchParams(window.location.search);
    const p = initialFilePath || params.get('filePath') || '';
    if (p && isTextNonMarkdown(p)) {
      return 'edit';
    }
    return 'wysiwyg';
  });
  const [currentEncoding, setCurrentEncoding] = useState<string>('UTF-8');
  const [encodingModalOpen, setEncodingModalOpen] = useState<boolean>(false);
  const [encodingAction, setEncodingAction] = useState<'choose_action' | 'reopen' | 'save'>('choose_action');
  const [encodingFilter, setEncodingFilter] = useState<string>('');
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isTitlebarPeeking, setIsTitlebarPeeking] = useState<boolean>(false);
  const titlebarHoverTimeoutRef = useRef<any>(null);
  const [fontSize, setFontSize] = useState<number>(13);
  const [zoomLevel, setZoomLevel] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('mhz_md_zoom_level');
      if (saved) {
        const val = parseFloat(saved);
        if (!isNaN(val) && val >= 0.5 && val <= 2.5) return val;
      }
    } catch (e) {}
    return 1.0;
  });
  const [showZoomHud, setShowZoomHud] = useState<boolean>(false);
  const zoomHudTimeoutRef = useRef<any>(null);
  const zoomSaveTimeoutRef = useRef<any>(null);
  const [wordWrap, setWordWrap] = useState<boolean>(true);
  const [splitRatio, setSplitRatio] = useState<number>(50); // percentage for editor
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const [showConfirmClose, setShowConfirmClose] = useState<boolean>(false);
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number }>({ line: 1, col: 1 });

  // Header filename context menu & inline renaming
  const [fileContextMenu, setFileContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isRenamingHeader, setIsRenamingHeader] = useState<boolean>(false);
  const [renameInputVal, setRenameInputVal] = useState<string>('');

  // MD to Plain Text Formatting Rules & Modal
  const [rulesModalOpen, setRulesModalOpen] = useState<boolean>(false);
  const [textRules, setTextRules] = useState<MdToTextRules>(() => loadSavedRules());

  // Text to MD Reverse Ingestion Modal & Rules
  const [ingestionModalOpen, setIngestionModalOpen] = useState<boolean>(false);
  const [reverseRules, setReverseRules] = useState<PatternRule[]>(() => loadStoredReverseRules());

  // Table of Contents (TOC) state
  const [showToc, setShowToc] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mhz_md_show_toc') === 'true';
    } catch {
      return false;
    }
  });
  const [tocFilter, setTocFilter] = useState<string>('');
  const showTocRef = useRef<boolean>(showToc);
  useEffect(() => {
    showTocRef.current = showToc;
    try {
      localStorage.setItem('mhz_md_show_toc', showToc.toString());
    } catch {}
  }, [showToc]);

  const isFullscreenRef = useRef<boolean>(false);
  useEffect(() => {
    isFullscreenRef.current = isFullscreen;
  }, [isFullscreen]);

  const modalsRef = useRef({
    rulesModalOpen: false,
    encodingModalOpen: false,
    ingestionModalOpen: false,
    showConfirmClose: false,
    fileContextMenu: false,
  });
  useEffect(() => {
    modalsRef.current = {
      rulesModalOpen,
      encodingModalOpen,
      ingestionModalOpen,
      showConfirmClose,
      fileContextMenu: !!fileContextMenu,
    };
  }, [rulesModalOpen, encodingModalOpen, ingestionModalOpen, showConfirmClose, fileContextMenu]);

  // WYSIWYG Block/Cell Editing states (Inspired by TreeDiadev's EditableCell)
  const [blocks, setBlocks] = useState<Block[]>(() => parseMarkdownToBlocks(''));
  const blocksRef = useRef<Block[]>(blocks);
  blocksRef.current = blocks;

  // Undo / Redo history
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const historyRef = useRef<HistoryItem[]>(history);
  historyRef.current = history;
  const historyIndexRef = useRef<number>(historyIndex);
  historyIndexRef.current = historyIndex;
  const textDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const MAX_HISTORY = 100;

  const pushHistory = useCallback((item: HistoryItem) => {
    const curIdx = historyIndexRef.current;
    const curHist = historyRef.current;
    const sliced = curHist.slice(0, curIdx + 1);
    sliced.push(item);
    if (sliced.length > MAX_HISTORY) {
      sliced.shift();
    }
    const newIdx = sliced.length - 1;
    historyRef.current = sliced;
    historyIndexRef.current = newIdx;
    setHistory(sliced);
    setHistoryIndex(newIdx);
  }, []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const fileName = useMemo(() => {
    if (!filePath) return 'Untitled.md';
    return filePath.split(/[/\\]/).pop() || 'Untitled.md';
  }, [filePath]);

  const isTextFile = useMemo(() => isTextNonMarkdown(filePath), [filePath]);

  // Dismiss header context menu on outside click
  useEffect(() => {
    const handleCloseMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.mhz-md-header-context-menu') || target.closest('.mhz-md-title-filename')) {
        return;
      }
      setFileContextMenu(null);
    };
    window.addEventListener('mousedown', handleCloseMenu);
    return () => window.removeEventListener('mousedown', handleCloseMenu);
  }, []);

  // Open containing folder in MHZipy
  const handleOpenFolderInMHZipy = useCallback(async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setFileContextMenu(null);
    if (!filePath) return;

    const normalized = filePath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    const folderPath = lastSlash !== -1 ? filePath.substring(0, lastSlash) : '';
    if (!folderPath) return;

    try {
      await emit('mhz-navigate-folder', {
        folderPath,
        selectPath: filePath
      });

      const allWins = await WebviewWindow.getAll();
      for (const w of allWins) {
        if (w.label === 'main' || !w.label.startsWith('md-editor-')) {
          await w.unminimize();
          await w.show();
          await w.setFocus();
          break;
        }
      }
    } catch (err) {
      console.error('Failed to navigate folder in MHZipy:', err);
    }
  }, [filePath]);

  // Trigger inline header rename
  const handleStartRename = useCallback((e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setFileContextMenu(null);
    if (!filePath) return;
    setRenameInputVal(fileName);
    setIsRenamingHeader(true);
  }, [filePath, fileName]);

  // Commit rename
  const handleCommitRename = useCallback(async () => {
    if (!isRenamingHeader) return;
    setIsRenamingHeader(false);

    const trimmed = renameInputVal.trim();
    if (!trimmed || trimmed === fileName || !filePath) return;

    if (/[\\/:*?"<>|]/.test(trimmed)) {
      setSaveNotification('Invalid filename characters: \\ / : * ? " < > |');
      setTimeout(() => setSaveNotification(null), 3000);
      return;
    }

    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const folderPath = lastSlash !== -1 ? filePath.substring(0, lastSlash) : '';
    const isWindows = filePath.includes('\\');
    const sep = isWindows ? '\\' : '/';
    const newFilePath = folderPath ? `${folderPath}${sep}${trimmed}` : trimmed;

    try {
      await rename(filePath, newFilePath);
      setFilePath(newFilePath);

      try {
        const win = getCurrentWindow();
        await win.setTitle(`${trimmed} - MHZipy Markdown Editor`);
      } catch { }

      await emit('mhz-refresh-files');

      setSaveNotification(`Renamed to ${trimmed}`);
      setTimeout(() => setSaveNotification(null), 2500);
    } catch (err) {
      console.error('Rename failed:', err);
      setSaveNotification(`Rename failed: ${String(err)}`);
      setTimeout(() => setSaveNotification(null), 3500);
    }
  }, [isRenamingHeader, renameInputVal, fileName, filePath]);

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
      if (isTextNonMarkdown(targetPath)) {
        setViewMode('edit');
      }
      setIsLoading(true);

      invoke<{ content: string; encoding: string }>('read_text_file_content', { path: targetPath, encoding: null })
        .then((res) => {
          setContent(res.content);
          setSavedContent(res.content);
          setCurrentEncoding(res.encoding || 'UTF-8');
          const currentDir = targetPath ? targetPath.replace(/[/\\][^/\\]+$/, '') : '';
          const loadedBlocks = !isTextNonMarkdown(targetPath) ? parseMarkdownToBlocks(res.content, currentDir) : [];
          blocksRef.current = loadedBlocks;
          setBlocks(loadedBlocks);
          const initialSnapshot: HistoryItem = { content: res.content, blocks: loadedBlocks.map(b => ({ ...b })) };
          historyRef.current = [initialSnapshot];
          historyIndexRef.current = 0;
          setHistory([initialSnapshot]);
          setHistoryIndex(0);
        })
        .catch((err) => {
          console.error('Failed to read text file:', err);
          const errorMsg = `// Failed to open file: ${String(err)}`;
          setContent(errorMsg);
          setSavedContent(errorMsg);
          const errBlocks = parseMarkdownToBlocks(errorMsg);
          blocksRef.current = errBlocks;
          setBlocks(errBlocks);
          const errSnapshot: HistoryItem = { content: errorMsg, blocks: errBlocks.map(b => ({ ...b })) };
          historyRef.current = [errSnapshot];
          historyIndexRef.current = 0;
          setHistory([errSnapshot]);
          setHistoryIndex(0);
        })
        .finally(() => {
          setIsLoading(false);
        });
    } else {
      const defaultText = `# Welcome\n\nStart typing markdown or text here.`;
      const initialBlocks = parseMarkdownToBlocks(defaultText);
      setContent(defaultText);
      setSavedContent(defaultText);
      blocksRef.current = initialBlocks;
      setBlocks(initialBlocks);
      const initialSnapshot: HistoryItem = { content: defaultText, blocks: initialBlocks.map(b => ({ ...b })) };
      historyRef.current = [initialSnapshot];
      historyIndexRef.current = 0;
      setHistory([initialSnapshot]);
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
        } catch { }
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

  // Sync Fullscreen state
  useEffect(() => {
    const checkFs = async () => {
      try {
        const win = getCurrentWindow();
        setIsFullscreen(await win.isFullscreen());
      } catch { }
    };
    checkFs();

    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  // Exit Fullscreen handler
  const exitFullscreen = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const isFs = await win.isFullscreen();
      if (isFs) {
        await win.setFullscreen(false);
      }
      setIsFullscreen(false);
      isFullscreenRef.current = false;
    } catch {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        }
        setIsFullscreen(false);
        isFullscreenRef.current = false;
      } catch (err) {
        console.warn('Exit fullscreen failed:', err);
      }
    }
  }, []);

  // Toggle Fullscreen handler
  const toggleFullscreen = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const cur = await win.isFullscreen();
      const next = !cur;
      await win.setFullscreen(next);
      setIsFullscreen(next);
      isFullscreenRef.current = next;
      if (next) {
        (document.activeElement as HTMLElement)?.blur?.();
      }
    } catch {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
          setIsFullscreen(true);
          isFullscreenRef.current = true;
          (document.activeElement as HTMLElement)?.blur?.();
        } else {
          await document.exitFullscreen();
          setIsFullscreen(false);
          isFullscreenRef.current = false;
        }
      } catch (err) {
        console.warn('Fullscreen toggle failed:', err);
      }
    }
  }, []);

  // Auto-hide Titlebar peek detector for Zen Fullscreen mode (Alt+F)
  useEffect(() => {
    if (!isFullscreen) {
      setIsTitlebarPeeking(false);
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      // If mouse is within top 20px of screen, peek titlebar
      if (e.clientY <= 20) {
        if (titlebarHoverTimeoutRef.current) {
          clearTimeout(titlebarHoverTimeoutRef.current);
          titlebarHoverTimeoutRef.current = null;
        }
        setIsTitlebarPeeking(true);
      } else if (e.clientY > 50) {
        // Mouse moved down towards document body
        if (!titlebarHoverTimeoutRef.current) {
          titlebarHoverTimeoutRef.current = setTimeout(() => {
            setIsTitlebarPeeking(false);
            titlebarHoverTimeoutRef.current = null;
          }, 120);
        }
      }
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (titlebarHoverTimeoutRef.current) clearTimeout(titlebarHoverTimeoutRef.current);
    };
  }, [isFullscreen]);

  // Helper to get active scroll container
  const getScrollContainer = useCallback((): HTMLElement | null => {
    if (viewMode === 'wysiwyg') {
      const el = document.querySelector('.mhz-td-wrapper') as HTMLElement | null;
      if (el) return el;
    } else if (viewMode === 'preview') {
      if (previewRef.current) return previewRef.current;
    } else if (viewMode === 'edit') {
      if (textareaRef.current) return textareaRef.current;
    } else if (viewMode === 'split') {
      if (document.activeElement === textareaRef.current) {
        return textareaRef.current;
      }
      return previewRef.current || textareaRef.current;
    }

    return (
      (document.querySelector('.mhz-td-wrapper') as HTMLElement | null) ||
      previewRef.current ||
      textareaRef.current ||
      (document.querySelector('.mhz-md-body') as HTMLElement | null)
    );
  }, [viewMode]);

  // Page flipping / smooth scrolling for keyboard navigation
  const scrollPage = useCallback(
    (direction: 'next' | 'prev' | 'top' | 'bottom', isFineStep = false) => {
      const container = getScrollContainer();
      if (!container) return;

      if (direction === 'top') {
        container.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (direction === 'bottom') {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        return;
      }

      // Page flip: 82% of visible height to maintain context continuity
      const pageDistance = Math.max(Math.floor(container.clientHeight * 0.82), 240);
      const stepDistance = isFineStep ? 140 : pageDistance;
      const delta = direction === 'next' ? stepDistance : -stepDistance;

      container.scrollBy({
        top: delta,
        behavior: 'smooth',
      });
    },
    [getScrollContainer]
  );

  // Update blocks from TreeEditableCell with structural history recording
  const handleUpdateBlocks = useCallback((newBlocks: Block[]) => {
    const prevBlocks = blocksRef.current;
    const cloned = newBlocks.map(b => ({ ...b }));
    const serialized = serializeBlocksToMarkdown(cloned);

    blocksRef.current = cloned;
    setBlocks(cloned);
    setContent(serialized);

    const isStructural = isBlockStructuralChange(prevBlocks, newBlocks);
    if (isStructural) {
      if (textDebounceTimerRef.current) {
        clearTimeout(textDebounceTimerRef.current);
        textDebounceTimerRef.current = null;
      }
      pushHistory({ content: serialized, blocks: cloned });
    } else {
      if (textDebounceTimerRef.current) {
        clearTimeout(textDebounceTimerRef.current);
      }
      textDebounceTimerRef.current = setTimeout(() => {
        pushHistory({ content: serialized, blocks: cloned });
        textDebounceTimerRef.current = null;
      }, 400);
    }
  }, [pushHistory]);

  // Revert / Convert current WYSIWYG blocks or Markdown text to formatted Plain Text according to rules
  const handleRevertToPlainText = useCallback((customRules?: MdToTextRules) => {
    const rulesToUse = customRules || textRules;
    let converted = '';
    if (viewMode === 'wysiwyg') {
      converted = convertBlocksToPlainText(blocks, rulesToUse);
    } else {
      converted = convertMarkdownToPlainText(content, rulesToUse);
    }
    setContent(converted);
    const newBlocks = parseMarkdownToBlocks(converted);
    blocksRef.current = newBlocks;
    setBlocks(newBlocks);
    setViewMode('edit');
    pushHistory({ content: converted, blocks: newBlocks.map(b => ({ ...b })) });
    setSaveNotification(`Reverted to Text (${rulesToUse.name.split('(')[0].trim()})`);
    setTimeout(() => setSaveNotification(null), 3500);
  }, [viewMode, blocks, content, textRules, pushHistory]);

  // Switch to WYSIWYG Mode (with option to review reverse ingestion)
  const handleSwitchToWysiwyg = useCallback((forceReviewModal = false) => {
    if (forceReviewModal || shouldShowIngestionModal()) {
      setIngestionModalOpen(true);
      return;
    }
    const newBlocks = parseTextToBlocksWithRules(content, reverseRules);
    blocksRef.current = newBlocks;
    setBlocks(newBlocks);
    setViewMode('wysiwyg');
    pushHistory({ content, blocks: newBlocks.map(b => ({ ...b })) });
    setSaveNotification('Switched to Markdown (WYSIWYG) Mode');
    setTimeout(() => setSaveNotification(null), 2500);
  }, [content, reverseRules, pushHistory]);

  const handleApplyIngestion = useCallback((newBlocks: Block[], updatedRules: PatternRule[]) => {
    setReverseRules(updatedRules);
    blocksRef.current = newBlocks;
    setBlocks(newBlocks);
    setViewMode('wysiwyg');
    pushHistory({ content, blocks: newBlocks.map(b => ({ ...b })) });
    setSaveNotification('Converted & Switched to Markdown Mode');
    setTimeout(() => setSaveNotification(null), 3000);
  }, [content, pushHistory]);

  // Sync Raw Content when switching from WYSIWYG mode
  const handleSwitchFromWysiwyg = useCallback((targetMode: 'split' | 'edit' | 'preview') => {
    if (viewMode === 'wysiwyg') {
      const newContent = isTextFile
        ? convertBlocksToPlainText(blocks, textRules)
        : serializeBlocksToMarkdown(blocks);
      setContent(newContent);
    }
    setViewMode(targetMode);
  }, [viewMode, isTextFile, blocks, textRules]);

  const handleApplyRules = useCallback((rules: MdToTextRules) => {
    setTextRules(rules);
    handleRevertToPlainText(rules);
  }, [handleRevertToPlainText]);

  // Update history on content changes (Source mode)
  const updateContentWithHistory = useCallback((newText: string) => {
    setContent(newText);
    const parsedBlocks = parseTextToBlocksWithRules(newText, reverseRules);
    blocksRef.current = parsedBlocks;
    setBlocks(parsedBlocks);
    pushHistory({ content: newText, blocks: parsedBlocks.map(b => ({ ...b })) });
  }, [pushHistory, reverseRules]);

  // Helper to find changed block between two block snapshots for Undo/Redo scroll
  const findChangedBlockId = (before: Block[], after: Block[]): string | null => {
    if (!after || !after.length) return null;
    if (!before || !before.length) return after[0]?.id || null;

    const maxLen = Math.max(before.length, after.length);
    for (let i = 0; i < maxLen; i++) {
      const b = before[i];
      const a = after[i];
      if (!b && a) return a.id;
      if (b && !a) {
        const targetIdx = Math.max(0, Math.min(i, after.length - 1));
        return after[targetIdx]?.id || null;
      }
      if (b && a) {
        if (
          b.id !== a.id ||
          b.html !== a.html ||
          b.type !== a.type ||
          b.checked !== a.checked ||
          b.align !== a.align ||
          b.indent !== a.indent ||
          b.listType !== a.listType ||
          b.isRaw !== a.isRaw
        ) {
          return a.id;
        }
      }
    }

    for (let i = 1; i <= maxLen; i++) {
      const b = before[before.length - i];
      const a = after[after.length - i];
      if (!b && a) return a.id;
      if (b && a && (b.id !== a.id || b.html !== a.html)) {
        return a.id;
      }
    }

    return after[0]?.id || null;
  };

  const findFirstDiffIndex = (str1: string, str2: string): number => {
    const len = Math.min(str1.length, str2.length);
    for (let i = 0; i < len; i++) {
      if (str1[i] !== str2[i]) return i;
    }
    return len;
  };

  // Automatically scroll the view to the changed part on Undo/Redo
  const scrollToChangedPart = useCallback((prev: HistoryItem, next: HistoryItem) => {
    if (viewMode === 'wysiwyg') {
      const changedBlockId = findChangedBlockId(prev.blocks, next.blocks);
      if (changedBlockId) {
        setTimeout(() => {
          const el = document.querySelector(`.mhz-td-block-row[data-block-id="${changedBlockId}"]`) as HTMLElement | null;
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('mhz-td-undo-highlight');
            setTimeout(() => {
              el.classList.remove('mhz-td-undo-highlight');
            }, 1200);
          }
        }, 60);
      }
    } else {
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          const diffIdx = findFirstDiffIndex(prev.content, next.content);
          ta.focus();
          ta.setSelectionRange(diffIdx, diffIdx);
          const linesBefore = next.content.substring(0, diffIdx).split('\n');
          const lineIndex = linesBefore.length - 1;
          const approxLineHeight = fontSize * 1.6;
          const targetScrollTop = Math.max(0, lineIndex * approxLineHeight - ta.clientHeight / 2);
          ta.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
        }
      }, 60);
    }
  }, [viewMode, fontSize]);

  // Undo / Redo
  const handleUndo = useCallback(() => {
    if (textDebounceTimerRef.current) {
      clearTimeout(textDebounceTimerRef.current);
      textDebounceTimerRef.current = null;
    }

    const curIdx = historyIndexRef.current;
    const curHist = historyRef.current;
    if (curIdx > 0 && curHist.length > 0) {
      const prevTarget = curHist[curIdx];
      const newIdx = curIdx - 1;
      const target = curHist[newIdx];
      historyIndexRef.current = newIdx;
      setHistoryIndex(newIdx);
      setContent(target.content);
      const clonedBlocks = target.blocks.map(b => ({ ...b }));
      blocksRef.current = clonedBlocks;
      setBlocks(clonedBlocks);
      scrollToChangedPart(prevTarget, target);
    }
  }, [scrollToChangedPart]);

  const handleRedo = useCallback(() => {
    if (textDebounceTimerRef.current) {
      clearTimeout(textDebounceTimerRef.current);
      textDebounceTimerRef.current = null;
    }

    const curIdx = historyIndexRef.current;
    const curHist = historyRef.current;
    if (curIdx < curHist.length - 1) {
      const prevTarget = curHist[curIdx];
      const newIdx = curIdx + 1;
      const target = curHist[newIdx];
      historyIndexRef.current = newIdx;
      setHistoryIndex(newIdx);
      setContent(target.content);
      const clonedBlocks = target.blocks.map(b => ({ ...b }));
      blocksRef.current = clonedBlocks;
      setBlocks(clonedBlocks);
      scrollToChangedPart(prevTarget, target);
    }
  }, [scrollToChangedPart]);

  // Save File
  const handleSave = useCallback(async () => {
    if (!filePath) return;
    setIsSaving(true);
    try {
      const textToSave = viewMode === 'wysiwyg'
        ? (isTextFile ? convertBlocksToPlainText(blocks, textRules) : serializeBlocksToMarkdown(blocks))
        : content;
      await invoke('save_text_file_content', { path: filePath, content: textToSave, encoding: currentEncoding });
      setSavedContent(textToSave);
      setContent(textToSave);
      setSaveNotification('Saved');
      setTimeout(() => setSaveNotification(null), 2500);
      try {
        await emit('mhz-refresh-files', { path: filePath });
      } catch (emitErr) {
        console.warn('Failed to emit mhz-refresh-files event:', emitErr);
      }
    } catch (err) {
      console.error('Failed to save file:', err);
      alert(`Save error: ${String(err)}`);
    } finally {
      setIsSaving(false);
    }
  }, [filePath, content, viewMode, blocks, currentEncoding, isTextFile, textRules]);

  // Reopen file with a specific encoding
  const handleReopenWithEncoding = async (encName: string) => {
    if (!filePath) return;
    setIsLoading(true);
    try {
      const res = await invoke<{ content: string; encoding: string }>('read_text_file_content', {
        path: filePath,
        encoding: encName,
      });
      const currentDir = filePath ? filePath.replace(/[/\\][^/\\]+$/, '') : '';
      const reopenedBlocks = parseMarkdownToBlocks(res.content, currentDir);
      setContent(res.content);
      setSavedContent(res.content);
      setCurrentEncoding(res.encoding || encName);
      blocksRef.current = reopenedBlocks;
      setBlocks(reopenedBlocks);
      const snapshot: HistoryItem = { content: res.content, blocks: reopenedBlocks.map(b => ({ ...b })) };
      historyRef.current = [snapshot];
      historyIndexRef.current = 0;
      setHistory([snapshot]);
      setHistoryIndex(0);
      setSaveNotification(`Reopened with ${res.encoding || encName}`);
      setTimeout(() => setSaveNotification(null), 2500);
    } catch (err) {
      console.error('Failed to reopen with encoding:', err);
      alert(`Failed to reopen with ${encName}: ${String(err)}`);
    } finally {
      setIsLoading(false);
      setEncodingModalOpen(false);
    }
  };

  // Save file with a specific encoding
  const handleSaveWithEncoding = async (encName: string) => {
    if (!filePath) return;
    setIsSaving(true);
    try {
      const textToSave = viewMode === 'wysiwyg'
        ? (isTextFile ? convertBlocksToPlainText(blocks, textRules) : serializeBlocksToMarkdown(blocks))
        : content;
      await invoke('save_text_file_content', {
        path: filePath,
        content: textToSave,
        encoding: encName,
      });
      setSavedContent(textToSave);
      setContent(textToSave);
      setCurrentEncoding(encName);
      setSaveNotification(`Saved with ${encName}`);
      setTimeout(() => setSaveNotification(null), 2500);
      try {
        await emit('mhz-refresh-files', { path: filePath });
      } catch { }
    } catch (err) {
      console.error('Failed to save with encoding:', err);
      alert(`Save error (${encName}): ${String(err)}`);
    } finally {
      setIsSaving(false);
      setEncodingModalOpen(false);
    }
  };

  const filteredEncodings = useMemo(() => {
    if (!encodingFilter.trim()) return SUPPORTED_ENCODINGS;
    const q = encodingFilter.toLowerCase().trim();
    return SUPPORTED_ENCODINGS.filter(
      (enc) =>
        enc.label.toLowerCase().includes(q) ||
        enc.name.toLowerCase().includes(q) ||
        enc.description.toLowerCase().includes(q)
    );
  }, [encodingFilter]);

  // Text selection & insertion helper for raw textarea or toolbar actions
  const insertText = useCallback((prefix: string, suffix: string = '', defaultText: string = '') => {
    if (viewMode === 'wysiwyg') {
      const updated = content ? `${content}\n${prefix}${defaultText}${suffix}` : `${prefix}${defaultText}${suffix}`;
      const newBlocks = parseMarkdownToBlocks(updated);
      blocksRef.current = newBlocks;
      setBlocks(newBlocks);
      setContent(updated);
      pushHistory({ content: updated, blocks: newBlocks.map(b => ({ ...b })) });
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
  }, [content, viewMode, updateContentWithHistory, pushHistory]);

  // Clean Blank Lines
  const handleCleanBlankLines = useCallback(() => {
    if (viewMode === 'wysiwyg') {
      const current = blocksRef.current;
      const isBlankBlock = (b: Block) => {
        if (b.type !== 'paragraph') return false;
        const stripped = (b.html || '')
          .replace(/<br\s*\/?>/gi, '')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, '')
          .replace(/\u200B/g, '')
          .trim();
        return stripped.length === 0;
      };

      const cleaned = current.filter(b => !isBlankBlock(b));
      const finalBlocks = cleaned.length > 0 ? cleaned : [{ id: generateId(), type: 'paragraph' as BlockType, html: '', indent: 0 }];
      const removedCount = current.length - cleaned.length;

      blocksRef.current = finalBlocks;
      setBlocks(finalBlocks);

      const newContent = isTextFile
        ? convertBlocksToPlainText(finalBlocks, textRules)
        : serializeBlocksToMarkdown(finalBlocks);
      setContent(newContent);
      pushHistory({ content: newContent, blocks: finalBlocks.map(b => ({ ...b })) });

      setSaveNotification(removedCount > 0 ? `Cleaned ${removedCount} blank line(s)` : 'No blank lines found');
      setTimeout(() => setSaveNotification(null), 2500);
    } else {
      const lines = content.split(/\r?\n/);
      const cleanedLines = lines.filter(l => l.trim().length > 0);
      const newText = cleanedLines.length > 0 ? cleanedLines.join('\n') : '';
      const removedCount = lines.length - cleanedLines.length;

      const newBlocks = parseMarkdownToBlocks(newText);
      blocksRef.current = newBlocks;
      setBlocks(newBlocks);
      setContent(newText);
      pushHistory({ content: newText, blocks: newBlocks.map(b => ({ ...b })) });

      setSaveNotification(removedCount > 0 ? `Cleaned ${removedCount} blank line(s)` : 'No blank lines found');
      setTimeout(() => setSaveNotification(null), 2500);
    }
  }, [viewMode, isTextFile, content, pushHistory, textRules]);

  // Insert image markdown / HTML to document at current position
  const insertImageToDocument = useCallback((relPath: string, _absPath: string, altText: string) => {
    const currentDir = filePath ? filePath.replace(/[/\\][^/\\]+$/, '') : '';
    const mdSnippet = `![${altText}](${relPath})`;

    if (viewMode === 'wysiwyg') {
      const current = blocksRef.current;
      const focusedEl = document.querySelector('.mhz-td-block-row.focused, .mhz-td-block-row:focus-within');
      const curFocusedId = focusedEl?.getAttribute('data-block-id');
      const targetIdx = curFocusedId ? current.findIndex(b => b.id === curFocusedId) : -1;

      const imgHtml = renderImageHtml(relPath, altText, '', currentDir);
      const newBlock: Block = {
        id: generateId(),
        type: 'paragraph',
        html: imgHtml,
        indent: 0,
      };

      let nextBlocks: Block[];
      if (targetIdx !== -1) {
        const curBlock = current[targetIdx];
        if (!curBlock.html || curBlock.html === '<br>' || curBlock.html.trim() === '') {
          nextBlocks = [...current.slice(0, targetIdx), newBlock, ...current.slice(targetIdx + 1)];
        } else {
          nextBlocks = [...current.slice(0, targetIdx + 1), newBlock, ...current.slice(targetIdx + 1)];
        }
      } else {
        nextBlocks = [...current, newBlock];
      }

      handleUpdateBlocks(nextBlocks);
      setTimeout(() => {
        const el = document.getElementById(`edit-${newBlock.id}`);
        if (el) {
          el.focus();
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 50);
    } else {
      const ta = textareaRef.current;
      if (ta) {
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const before = content.substring(0, start);
        const after = content.substring(end);
        const prefix = before.endsWith('\n') || before === '' ? '' : '\n';
        const suffix = after.startsWith('\n') || after === '' ? '\n' : '\n';
        const inserted = `${prefix}${mdSnippet}${suffix}`;
        const newText = before + inserted + after;
        updateContentWithHistory(newText);
        setTimeout(() => {
          ta.focus();
          const newPos = start + inserted.length;
          ta.setSelectionRange(newPos, newPos);
        }, 10);
      } else {
        updateContentWithHistory(content + '\n' + mdSnippet + '\n');
      }
    }
  }, [viewMode, content, handleUpdateBlocks, updateContentWithHistory]);

  // Handle saving pasted/dropped image blob to file in the same directory as the markdown file
  const handleProcessImageBlob = useCallback(async (blob: Blob, suggestedName?: string) => {
    const currentDir = filePath ? filePath.replace(/[/\\][^/\\]+$/, '') : '';
    if (!currentDir) {
      setSaveNotification('No document folder found. Please save the markdown file first.');
      setTimeout(() => setSaveNotification(null), 3000);
      return;
    }

    try {
      const now = new Date();
      const pad = (n: number) => n.toString().padStart(2, '0');
      const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

      let ext = 'png';
      if (blob.type === 'image/jpeg') ext = 'jpg';
      else if (blob.type === 'image/webp') ext = 'webp';
      else if (blob.type === 'image/gif') ext = 'gif';
      else if (blob.type === 'image/svg+xml') ext = 'svg';

      const baseName = suggestedName ? suggestedName.replace(/\.[^.]+$/, '') : `image_${dateStr}`;
      let targetFileName = `${baseName}.${ext}`;
      let targetFilePath = `${currentDir}/${targetFileName}`;

      let counter = 1;
      while (await exists(targetFilePath)) {
        targetFileName = `${baseName}_${counter}.${ext}`;
        targetFilePath = `${currentDir}/${targetFileName}`;
        counter++;
      }

      const buffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(buffer);
      await writeFile(targetFilePath, uint8);

      const relPath = `./${targetFileName}`;
      insertImageToDocument(relPath, targetFilePath, baseName);
      setSaveNotification(`Image saved and linked: ${targetFileName}`);
      setTimeout(() => setSaveNotification(null), 2500);
    } catch (err) {
      console.error('Failed to save image:', err);
      setSaveNotification(`Failed to save image: ${String(err)}`);
      setTimeout(() => setSaveNotification(null), 3000);
    }
  }, [filePath, insertImageToDocument]);

  // Handle pasting local image file paths from clipboard (e.g. copied from Windows Explorer)
  const handleProcessLocalImageFiles = useCallback(async (filePaths: string[]) => {
    const currentDir = filePath ? filePath.replace(/[/\\][^/\\]+$/, '') : '';
    if (!currentDir) {
      setSaveNotification('No document folder found. Please save the markdown file first.');
      setTimeout(() => setSaveNotification(null), 3000);
      return;
    }

    for (const srcPath of filePaths) {
      try {
        const fileName = srcPath.replace(/^.*[/\\]/, '');
        const targetFilePath = `${currentDir}/${fileName}`;

        // If source is not already in the document's directory, copy it over!
        if (srcPath.replace(/\\/g, '/').toLowerCase() !== targetFilePath.replace(/\\/g, '/').toLowerCase()) {
          await copyFile(srcPath, targetFilePath);
        }

        const relPath = `./${fileName}`;
        insertImageToDocument(relPath, targetFilePath, fileName.replace(/\.[^.]+$/, ''));
        setSaveNotification(`Image linked: ${fileName}`);
        setTimeout(() => setSaveNotification(null), 2500);
      } catch (err) {
        console.error('Failed to copy/link image file:', err);
      }
    }
  }, [filePath, insertImageToDocument]);

  // Global Paste Event Listener for images
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      // 1. Check if clipboard has image bitmap data (screenshot, browser copy, etc.)
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.startsWith('image/')) {
            e.preventDefault();
            e.stopPropagation();
            const blob = item.getAsFile();
            if (blob) {
              await handleProcessImageBlob(blob);
              return;
            }
          }
        }
      }

      // 2. Check if clipboard contains copied files from Windows Explorer
      try {
        const clipboardFiles = await invoke<string[]>('get_files_from_clipboard');
        if (clipboardFiles && clipboardFiles.length > 0) {
          const imgPaths = clipboardFiles.filter(p => /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(p));
          if (imgPaths.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            await handleProcessLocalImageFiles(imgPaths);
            return;
          }
        }
      } catch {}
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handleProcessImageBlob, handleProcessLocalImageFiles]);

  // Heading dropdown state and handlers
  const [headingMenuOpen, setHeadingMenuOpen] = useState<boolean>(false);
  const headingMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (headingMenuRef.current && !headingMenuRef.current.contains(e.target as Node)) {
        setHeadingMenuOpen(false);
      }
    };
    if (headingMenuOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [headingMenuOpen]);

  const handleInsertHeading = useCallback((level: number) => {
    setHeadingMenuOpen(false);
    insertText('#'.repeat(level) + ' ', '', `Heading ${level}`);
  }, [insertText]);

  const [isCopied, setIsCopied] = useState<boolean>(false);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Copy all content helper (used in Titlebar copy button)
  const handleCopyAll = useCallback(() => {
    const textToCopy = viewMode === 'wysiwyg'
      ? (isTextFile ? convertBlocksToPlainText(blocks, textRules) : serializeBlocksToMarkdown(blocks))
      : content;
    navigator.clipboard.writeText(textToCopy);
    setIsCopied(true);
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    copyFeedbackTimerRef.current = setTimeout(() => setIsCopied(false), 1600);

    setSaveNotification(isTextFile ? 'Text copied' : 'Markdown copied');
    setTimeout(() => setSaveNotification(null), 2000);
  }, [isTextFile, viewMode, blocks, content, textRules]);

  // Reset any global window zoom so Titlebar, Toolbar, and Statusbar stay 100% fixed
  useEffect(() => {
    try {
      const webview = getCurrentWebviewWindow();
      if (webview && typeof webview.setZoom === 'function') {
        webview.setZoom(1.0);
      }
    } catch (e) {}
    (document.documentElement.style as any).zoom = '';

    return () => {
      if (zoomHudTimeoutRef.current) clearTimeout(zoomHudTimeoutRef.current);
      if (zoomSaveTimeoutRef.current) clearTimeout(zoomSaveTimeoutRef.current);
    };
  }, []);

  // MD File Content Zoom Control (Zooms only the document body)
  const triggerZoomChange = useCallback((delta: number | 'reset') => {
    setZoomLevel((prev) => {
      let next: number;
      if (delta === 'reset') {
        next = 1.0;
      } else {
        next = Math.max(0.5, Math.min(2.5, Math.round((prev + delta) * 10) / 10));
      }

      setShowZoomHud(true);
      if (zoomHudTimeoutRef.current) clearTimeout(zoomHudTimeoutRef.current);
      zoomHudTimeoutRef.current = setTimeout(() => setShowZoomHud(false), 1600);

      if (zoomSaveTimeoutRef.current) clearTimeout(zoomSaveTimeoutRef.current);
      zoomSaveTimeoutRef.current = setTimeout(() => {
        try {
          localStorage.setItem('mhz_md_zoom_level', next.toString());
        } catch (e) {}
      }, 500);

      return next;
    });
  }, []);

  // Global Keydown Handler (Save shortcut, Undo/Redo, Zoom shortcuts, Alt+F Reading controls, Alt+T TOC)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // 1. Ctrl+S / Cmd+S (Save)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSave();
        return;
      }
      // 2. Ctrl+Z (Undo) - without Shift
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleUndo();
        return;
      }
      // 3. Ctrl+Y or Ctrl+Shift+Z (Redo)
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        e.stopPropagation();
        handleRedo();
        return;
      }
      // 4. Alt+F or F11 (Toggle Fullscreen / Reading Mode)
      if ((e.altKey && (e.key === 'f' || e.key === 'F')) || e.key === 'F11') {
        e.preventDefault();
        e.stopPropagation();
        toggleFullscreen();
        return;
      }
      // Alt+T (Toggle Table of Contents - TOC)
      if (e.altKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        e.stopPropagation();
        setShowToc((prev) => !prev);
        return;
      }
      // 5. ESC (Exit Zen Fullscreen, Close TOC, or Close active modals)
      if (e.key === 'Escape') {
        if (showTocRef.current) {
          e.preventDefault();
          setShowToc(false);
          return;
        }
        if (modalsRef.current.rulesModalOpen) {
          e.preventDefault();
          setRulesModalOpen(false);
          return;
        }
        if (modalsRef.current.encodingModalOpen) {
          e.preventDefault();
          setEncodingModalOpen(false);
          return;
        }
        if (modalsRef.current.ingestionModalOpen) {
          e.preventDefault();
          setIngestionModalOpen(false);
          return;
        }
        if (modalsRef.current.fileContextMenu) {
          e.preventDefault();
          setFileContextMenu(null);
          return;
        }
        if (modalsRef.current.showConfirmClose) {
          e.preventDefault();
          setShowConfirmClose(false);
          return;
        }
        if (isFullscreenRef.current || !!document.fullscreenElement) {
          e.preventDefault();
          e.stopPropagation();
          exitFullscreen();
          return;
        }
        getCurrentWindow().isFullscreen().then((isFs) => {
          if (isFs) {
            exitFullscreen();
          }
        }).catch(() => {});
        return;
      }

      // 6. Navigation in Fullscreen Reading Mode (Alt+F)
      if (isFullscreenRef.current || !!document.fullscreenElement) {
        const activeTag = document.activeElement?.tagName;
        const isInput = activeTag === 'INPUT';
        const isEditingRaw = activeTag === 'TEXTAREA' && viewMode === 'edit';

        if (!isInput && !isEditingRaw) {
          // Arrow Down / Arrow Right / PageDown -> Next Page
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') {
            e.preventDefault();
            e.stopPropagation();
            scrollPage('next', e.shiftKey && e.key === 'ArrowDown');
            return;
          }
          // Arrow Up / Arrow Left / PageUp -> Previous Page
          if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') {
            e.preventDefault();
            e.stopPropagation();
            scrollPage('prev', e.shiftKey && e.key === 'ArrowUp');
            return;
          }
          // Space -> Next Page, Shift+Space -> Previous Page
          if (e.key === ' ' || e.code === 'Space') {
            e.preventDefault();
            e.stopPropagation();
            scrollPage(e.shiftKey ? 'prev' : 'next');
            return;
          }
          // Home -> Jump to Top
          if (e.key === 'Home') {
            e.preventDefault();
            e.stopPropagation();
            scrollPage('top');
            return;
          }
          // End -> Jump to Bottom
          if (e.key === 'End') {
            e.preventDefault();
            e.stopPropagation();
            scrollPage('bottom');
            return;
          }
        }
      }

      // 7. Ctrl + '+' or '=' or 'Add' (Zoom In)
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+' || e.key === 'Add')) {
        e.preventDefault();
        triggerZoomChange(0.1);
        return;
      }
      // 8. Ctrl + '-' or 'Subtract' (Zoom Out)
      if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === 'Subtract')) {
        e.preventDefault();
        triggerZoomChange(-0.1);
        return;
      }
      // 9. Ctrl + '0' (Reset Zoom)
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        triggerZoomChange('reset');
        return;
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [handleSave, handleUndo, handleRedo, toggleFullscreen, exitFullscreen, scrollPage, triggerZoomChange, viewMode]);

  // Ctrl + Mouse Wheel Zoom Handler
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY < 0 ? 0.1 : -0.1;
        triggerZoomChange(delta);
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', handleWheel);
    };
  }, [triggerZoomChange]);

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
    if (!isTextFile) {
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
    const text = viewMode === 'wysiwyg'
      ? (isTextFile ? convertBlocksToPlainText(blocks, textRules) : serializeBlocksToMarkdown(blocks))
      : content;
    const lines = text.split('\n').length;
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return { lines, chars, words };
  }, [content, blocks, viewMode, isTextFile, textRules]);

  // Rendered preview HTML for Split or Preview mode
  const renderedFullHtml = useMemo(() => {
    const text = viewMode === 'wysiwyg' ? serializeBlocksToMarkdown(blocks) : content;
    if (!text.trim()) {
      return '';
    }
    try {
      const currentDir = filePath ? filePath.replace(/[/\\][^/\\]+$/, '') : '';
      return renderMarkdown(text, currentDir);
    } catch (e) {
      return `<p style="color: #ef4444;">Rendering Error: ${String(e)}</p>`;
    }
  }, [content, blocks, viewMode, filePath]);

  // Line count for gutter
  const lineNumbersArray = useMemo(() => {
    const count = content.split('\n').length;
    return Array.from({ length: count }, (_, i) => i + 1);
  }, [content]);

  // Automatic TOC generation from document headings
  const tocItems = useMemo<TocItem[]>(() => {
    if (viewMode === 'wysiwyg') {
      const items: TocItem[] = [];
      blocks.forEach((block) => {
        if (/^h[1-6]$/.test(block.type)) {
          const level = parseInt(block.type[1], 10);
          const rawText = block.html
            ? block.html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\u200B/g, '').trim()
            : '';
          items.push({
            id: block.id,
            blockId: block.id,
            level,
            text: rawText || `Heading ${level}`,
          });
        }
      });
      return items;
    } else {
      const items: TocItem[] = [];
      const lines = content.split('\n');
      let inCodeBlock = false;
      lines.forEach((line, lineIdx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('```')) {
          inCodeBlock = !inCodeBlock;
          return;
        }
        if (inCodeBlock) return;
        const match = /^(#{1,6})\s+(.+)$/.exec(trimmed);
        if (match) {
          const level = match[1].length;
          const cleanText = match[2]
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .replace(/`(.*?)`/g, '$1')
            .trim();
          items.push({
            id: `line-${lineIdx}`,
            level,
            text: cleanText || `Heading ${level}`,
            lineIndex: lineIdx,
          });
        }
      });
      return items;
    }
  }, [viewMode, blocks, content]);

  const filteredTocItems = useMemo(() => {
    if (!tocFilter.trim()) return tocItems;
    const q = tocFilter.toLowerCase().trim();
    return tocItems.filter((item) => item.text.toLowerCase().includes(q));
  }, [tocItems, tocFilter]);

  const handleJumpToHeading = useCallback((item: TocItem, index: number) => {
    if (viewMode === 'wysiwyg' && item.blockId) {
      const el = document.getElementById(`edit-${item.blockId}`) ||
                 document.querySelector(`[data-block-id="${item.blockId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('mhz-heading-target-pulse');
        setTimeout(() => el.classList.remove('mhz-heading-target-pulse'), 1500);
        return;
      }
    }

    if (viewMode === 'preview' || viewMode === 'split') {
      if (previewRef.current) {
        const headings = previewRef.current.querySelectorAll('h1, h2, h3, h4, h5, h6');
        const target = headings[index] as HTMLElement | undefined;
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          target.classList.add('mhz-heading-target-pulse');
          setTimeout(() => target.classList.remove('mhz-heading-target-pulse'), 1500);
        }
      }
    }

    if (viewMode === 'edit' || viewMode === 'split') {
      if (textareaRef.current && item.lineIndex !== undefined) {
        const lines = content.split('\n');
        let charPos = 0;
        for (let i = 0; i < item.lineIndex && i < lines.length; i++) {
          charPos += lines[i].length + 1;
        }
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(charPos, charPos);
        const lineHeight = fontSize * 1.6;
        textareaRef.current.scrollTo({ top: Math.max(0, item.lineIndex * lineHeight - 60), behavior: 'smooth' });
      }
    }
  }, [viewMode, content, fontSize]);

  return (
    <div className={`mhz-md-root ${isFullscreen ? 'mhz-md-zen-fullscreen' : ''}`}>
      {/* 1. Custom Frameless Titlebar with Window Dragging */}
      <div
        className={`mhz-md-titlebar ${isTitlebarPeeking ? 'peeking' : ''}`}
        data-tauri-drag-region
        onMouseDown={handleTitlebarMouseDown}
        onDoubleClick={handleToggleMaximize}
        onMouseEnter={() => {
          if (isFullscreen) {
            if (titlebarHoverTimeoutRef.current) {
              clearTimeout(titlebarHoverTimeoutRef.current);
              titlebarHoverTimeoutRef.current = null;
            }
            setIsTitlebarPeeking(true);
          }
        }}
        onMouseLeave={(e) => {
          if (isFullscreen && e.clientY > 45) {
            setIsTitlebarPeeking(false);
          }
        }}
      >
        <div className="mhz-md-titlebar-left">
          <div className="mhz-md-app-icon">
            <FileText size={17} />
          </div>
          {isRenamingHeader ? (
            <input
              type="text"
              className="mhz-md-title-rename-input"
              value={renameInputVal}
              onChange={(e) => setRenameInputVal(e.target.value)}
              onBlur={handleCommitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleCommitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setIsRenamingHeader(false);
                }
              }}
              autoFocus
              onFocus={(e) => {
                const dotIdx = e.target.value.lastIndexOf('.');
                if (dotIdx > 0) {
                  e.target.setSelectionRange(0, dotIdx);
                } else {
                  e.target.select();
                }
              }}
            />
          ) : (
            <span
              className="mhz-md-title-filename"
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                setFileContextMenu({ x: rect.left, y: rect.bottom + 6 });
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                handleStartRename();
              }}
              title="Right-click for options (Open Folder in MHZipy, Rename) / Double-click to rename"
            >
              {fileName}
            </span>
          )}
          <button
            type="button"
            className={`mhz-md-status-badge ${isDirty ? 'dirty' : 'saved'}`}
            onClick={handleSave}
            disabled={isSaving}
            title={isDirty ? "Click to save changes (Ctrl+S)" : "All changes saved (Click to re-save)"}
          >
            {isSaving ? '⏳ Saving...' : isDirty ? '● Unsaved' : '✓ Saved'}
          </button>
          <div className="mhz-md-titlebar-history-group">
            <button
              type="button"
              className="mhz-md-titlebar-icon-btn"
              onClick={handleUndo}
              disabled={historyIndex <= 0}
              title="Undo (Ctrl+Z)"
            >
              <Undo2 size={13} />
            </button>
            <button
              type="button"
              className="mhz-md-titlebar-icon-btn"
              onClick={handleRedo}
              disabled={historyIndex >= history.length - 1}
              title="Redo (Ctrl+Y)"
            >
              <Redo2 size={13} />
            </button>
          </div>
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
            type="button"
            className="mhz-md-win-btn"
            onClick={handleCopyAll}
            title={isCopied ? "Copied to Clipboard!" : (isTextFile ? "Copy Text to Clipboard" : "Copy Markdown to Clipboard")}
          >
            {isCopied ? <ClipboardCheck size={13} style={{ color: '#34d399' }} /> : <ClipboardCopy size={13} />}
          </button>
          <button
            type="button"
            className="mhz-md-win-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit Fullscreen (Alt+F)" : "Fullscreen (Alt+F)"}
          >
            {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
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

      {/* 2. Top Action Toolbar (Centered & Compact) */}
      <div className="mhz-md-toolbar">
        {/* Converter & Rules Group */}
        <div className="mhz-md-toolbar-group">
          {viewMode === 'wysiwyg' ? (
            <button
              type="button"
              className="mhz-md-tool-btn primary"
              onClick={() => handleRevertToPlainText()}
              title="Convert current Markdown blocks to Plain Text format using defined rules and return to Source/Text editor"
            >
              <FileText size={14} />
              <span>Revert to Plain Text</span>
            </button>
          ) : (
            <div style={{ display: 'inline-flex', alignItems: 'center' }}>
              <button
                type="button"
                className="mhz-md-tool-btn primary"
                onClick={() => handleSwitchToWysiwyg(false)}
                title="Switch to Markdown / WYSIWYG Block mode"
                style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
              >
                <Sparkles size={14} />
                <span>Switch to MD Mode</span>
              </button>
              <button
                type="button"
                className="mhz-md-tool-btn primary"
                onClick={() => handleSwitchToWysiwyg(true)}
                title="Review parsing rules and custom pattern mapping"
                style={{
                  borderTopLeftRadius: 0,
                  borderBottomLeftRadius: 0,
                  borderLeft: '1px solid rgba(255,255,255,0.25)',
                  paddingLeft: '5px',
                  paddingRight: '5px',
                }}
              >
                <Sliders size={12} />
              </button>
            </div>
          )}

          {viewMode !== 'wysiwyg' && (
            <button
              type="button"
              className="mhz-md-tool-btn"
              onClick={() => handleRevertToPlainText()}
              title="Apply formatting rules to clean and format current text"
            >
              <FileText size={14} />
              <span>Format as Plain Text</span>
            </button>
          )}

          <button
            type="button"
            className="mhz-md-tool-btn"
            onClick={() => setRulesModalOpen(true)}
            title="Configure MD → Plain Text Formatting Rules"
          >
            <Sliders size={14} />
            <span>Text Export Rules</span>
          </button>
        </div>

        <div className="mhz-md-toolbar-sep" />

        {/* Markdown & Cell Formatting Tools (Shown when in WYSIWYG mode or when editing Markdown file) */}
        {(viewMode === 'wysiwyg' || !isTextFile) && (
          <>
            <div className="mhz-md-toolbar-group">
              {/* Single Unified Heading Button (H1~H6) */}
              <div className="mhz-md-dropdown-container" ref={headingMenuRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  className={`mhz-md-tool-btn ${headingMenuOpen ? 'active' : ''}`}
                  onClick={() => setHeadingMenuOpen(prev => !prev)}
                  title="Headings (H1 ~ H6)"
                >
                  <strong style={{ fontSize: '13px', lineHeight: 1 }}>H</strong>
                  <ChevronDown size={11} style={{ marginLeft: '-1px' }} />
                </button>
                {headingMenuOpen && (
                  <div className="mhz-md-heading-dropdown-menu">
                    {[1, 2, 3, 4, 5, 6].map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        className="mhz-md-heading-menu-item"
                        onClick={() => handleInsertHeading(lvl)}
                      >
                        <span className="lvl-badge">H{lvl}</span>
                        <span className="lvl-title">Heading {lvl}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

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
          </>
        )}

        <div className="mhz-md-toolbar-sep" />

        {/* Editor Settings Group */}
        <div className="mhz-md-toolbar-group">
          <button
            type="button"
            className="mhz-md-tool-btn"
            onClick={handleCleanBlankLines}
            title="Remove Blank Lines"
          >
            <Sparkles size={14} />
          </button>
          <button
            className={`mhz-md-tool-btn ${wordWrap ? 'active' : ''}`}
            onClick={() => setWordWrap(!wordWrap)}
            title="Toggle Word Wrap"
          >
            <WrapText size={14} />
          </button>
          <button
            type="button"
            className={`mhz-md-tool-btn mhz-md-toc-toggle-btn ${showToc ? 'active' : ''}`}
            onClick={() => setShowToc((prev) => !prev)}
            title="Table of Contents (Alt+T)"
          >
            <ListTree size={14} />
            <span style={{ fontSize: '11px', fontWeight: 500 }}>TOC</span>
            {tocItems.length > 0 && (
              <span className="mhz-md-toc-badge">{tocItems.length}</span>
            )}
          </button>
        </div>
      </div>

      {/* 3. Main Body */}
      <div
        className="mhz-md-body"
        style={{
          zoom: zoomLevel,
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={async (e) => {
          const files = e.dataTransfer.files;
          if (files && files.length > 0) {
            const imgFiles: File[] = [];
            for (let i = 0; i < files.length; i++) {
              if (files[i].type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(files[i].name)) {
                imgFiles.push(files[i]);
              }
            }
            if (imgFiles.length > 0) {
              e.preventDefault();
              e.stopPropagation();
              for (const f of imgFiles) {
                await handleProcessImageBlob(f, f.name);
              }
            }
          }
        }}
      >
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
                  baseDir={filePath ? filePath.replace(/[/\\][^/\\]+$/, '') : ''}
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
          {/* View Mode Selector in Status Bar */}
          <label className="mhz-md-statusbar-select-wrapper" title="Change View Mode">
            <span>Mode:</span>
            <select
              className="mhz-md-statusbar-select"
              value={viewMode}
              onChange={(e) => {
                const mode = e.target.value as 'wysiwyg' | 'split' | 'edit' | 'preview';
                if (mode === 'wysiwyg') handleSwitchToWysiwyg();
                else handleSwitchFromWysiwyg(mode);
              }}
            >
              <option value="wysiwyg">WYSIWYG (MD Blocks)</option>
              <option value="split">Split</option>
              <option value="edit">{isTextFile ? 'Source (Plain Text)' : 'Source (Markdown)'}</option>
              <option value="preview">Preview</option>
            </select>
          </label>

          <button
            type="button"
            className="mhz-md-statusbar-btn"
            onClick={() => {
              setEncodingAction('choose_action');
              setEncodingFilter('');
              setEncodingModalOpen(true);
            }}
            title="Click to change encoding (Reopen or Save with Encoding)"
          >
            Encoding: <strong>{currentEncoding}</strong>
          </button>
          <label className="mhz-md-statusbar-select-wrapper" title="Click to select font size">
            <span>Font:</span>
            <select
              className="mhz-md-statusbar-select"
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
            >
              {(FONT_SIZES.includes(fontSize) ? FONT_SIZES : [...FONT_SIZES, fontSize].sort((a, b) => a - b)).map((sz) => (
                <option key={sz} value={sz}>
                  {sz}px
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="mhz-md-statusbar-btn"
            onClick={() => triggerZoomChange('reset')}
            title="Screen Zoom: Ctrl + Mouse Wheel / Ctrl + 0 to reset (Click to reset 100%)"
          >
            Zoom: <strong>{Math.round(zoomLevel * 100)}%</strong>
          </button>
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

      {/* 6. Encoding Dialog Modal (Reopen with Encoding / Save with Encoding) */}
      {encodingModalOpen && (
        <div className="mhz-md-modal-backdrop" onClick={() => setEncodingModalOpen(false)}>
          <div
            className="mhz-md-modal mhz-md-encoding-modal"
            onClick={(e) => e.stopPropagation()}
            style={{ width: '460px', maxWidth: '92vw' }}
          >
            <div className="mhz-md-modal-header" style={{ justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {encodingAction !== 'choose_action' && (
                  <button
                    type="button"
                    className="mhz-md-tool-btn"
                    style={{ padding: '2px 4px', marginRight: '2px' }}
                    onClick={() => {
                      setEncodingAction('choose_action');
                      setEncodingFilter('');
                    }}
                    title="Back to encoding actions"
                  >
                    <ArrowLeft size={16} />
                  </button>
                )}
                <span>
                  {encodingAction === 'choose_action'
                    ? 'File Encoding'
                    : encodingAction === 'reopen'
                      ? 'Reopen with Encoding'
                      : 'Save with Encoding'}
                </span>
              </div>
              <button
                type="button"
                className="mhz-md-tool-btn"
                style={{ padding: '2px 4px' }}
                onClick={() => setEncodingModalOpen(false)}
                title="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mhz-md-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {encodingAction === 'choose_action' ? (
                <>
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                    Current active encoding: <strong style={{ color: '#38bdf8' }}>{currentEncoding}</strong>
                  </div>

                  <button
                    type="button"
                    className="mhz-md-encoding-action-card"
                    onClick={() => {
                      setEncodingAction('reopen');
                      setEncodingFilter('');
                    }}
                  >
                    <RotateCw size={20} color="#38bdf8" className="card-icon" />
                    <div>
                      <div className="card-title">Reopen with Encoding</div>
                      <div className="card-desc">
                        Re-reads '{fileName}' from disk using a different character encoding.
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    className="mhz-md-encoding-action-card"
                    onClick={() => {
                      setEncodingAction('save');
                      setEncodingFilter('');
                    }}
                  >
                    <Save size={20} color="#34d399" className="card-icon" />
                    <div>
                      <div className="card-title">Save with Encoding</div>
                      <div className="card-desc">
                        Saves current editor content to disk encoded in the selected format.
                      </div>
                    </div>
                  </button>
                </>
              ) : (
                <>
                  {encodingAction === 'reopen' && isDirty && (
                    <div className="mhz-md-encoding-dirty-warning">
                      <AlertCircle size={16} style={{ flexShrink: 0 }} />
                      <span>Warning: You have unsaved changes. Reopening will discard them!</span>
                    </div>
                  )}

                  {/* Search Filter */}
                  <div className="mhz-md-encoding-search-box">
                    <Search size={14} color="#64748b" />
                    <input
                      type="text"
                      placeholder="Search encoding (e.g., UTF-8, EUC-KR, CP949)..."
                      value={encodingFilter}
                      onChange={(e) => setEncodingFilter(e.target.value)}
                      autoFocus
                    />
                    {encodingFilter && (
                      <button type="button" onClick={() => setEncodingFilter('')}>
                        <X size={13} />
                      </button>
                    )}
                  </div>

                  {/* List of Encodings */}
                  <div className="mhz-md-encoding-list">
                    {filteredEncodings.length === 0 ? (
                      <div style={{ padding: '16px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
                        No matching encodings found.
                      </div>
                    ) : (
                      filteredEncodings.map((enc) => {
                        const isActive = enc.name.toLowerCase() === currentEncoding.toLowerCase();
                        return (
                          <button
                            key={enc.name}
                            type="button"
                            className={`mhz-md-encoding-item ${isActive ? 'active' : ''}`}
                            onClick={() => {
                              if (encodingAction === 'reopen') {
                                handleReopenWithEncoding(enc.name);
                              } else {
                                handleSaveWithEncoding(enc.name);
                              }
                            }}
                          >
                            <div className="encoding-item-left">
                              <span className="encoding-label">{enc.label}</span>
                              <span className="encoding-desc">{enc.description}</span>
                            </div>
                            {isActive && (
                              <span className="encoding-item-badge">
                                <Check size={11} /> Current
                              </span>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="mhz-md-modal-actions" style={{ marginTop: '4px' }}>
              <button
                type="button"
                className="mhz-md-modal-btn cancel"
                onClick={() => setEncodingModalOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7. Header File Context Menu (Fixed Overlay) */}
      {fileContextMenu && (
        <div
          className="mhz-md-header-context-menu"
          style={{ top: fileContextMenu.y, left: fileContextMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="mhz-md-header-context-item"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleOpenFolderInMHZipy}
          >
            <Folder size={14} className="icon" />
            <span>Open Folder (MHZipy)</span>
          </button>
          <button
            type="button"
            className="mhz-md-header-context-item"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleStartRename}
          >
            <Edit3 size={14} className="icon" />
            <span>Rename</span>
          </button>
        </div>
      )}

      {/* 8. Zen Fullscreen Reading Navigation & Exit Bar */}
      {isFullscreen && (
        <div className="mhz-md-zen-nav-bar">
          <button
            type="button"
            className="mhz-md-zen-nav-btn"
            onClick={() => scrollPage('prev')}
            title="Previous Page (↑ / ← / PageUp)"
          >
            <ChevronUp size={14} />
            <span>Prev (↑)</span>
          </button>
          <button
            type="button"
            className="mhz-md-zen-nav-btn"
            onClick={() => scrollPage('next')}
            title="Next Page (↓ / → / Space / PageDown)"
          >
            <ChevronDown size={14} />
            <span>Next (↓)</span>
          </button>
          <div className="mhz-md-zen-nav-divider" />
          <button
            type="button"
            className="mhz-md-zen-exit-pill"
            onClick={exitFullscreen}
            title="Exit Reading Mode (ESC / Alt+F)"
          >
            <Minimize2 size={13} />
            <span>Exit (ESC)</span>
          </button>
        </div>
      )}

      {/* 9. Markdown to Plain Text Conversion Rules Modal */}
      <MdToTextRulesModal
        isOpen={rulesModalOpen}
        onClose={() => setRulesModalOpen(false)}
        currentRules={textRules}
        onApplyRules={handleApplyRules}
      />

      {/* 10. Text to Markdown Reverse Ingestion Modal */}
      <TextToMdIngestionModal
        isOpen={ingestionModalOpen}
        onClose={() => setIngestionModalOpen(false)}
        documentText={content}
        initialRules={reverseRules}
        onApplyIngestion={handleApplyIngestion}
      />

      {/* 11. Zoom HUD Overlay */}
      {showZoomHud && (
        <div className="zoom-hud">
          <span className="zoom-hud-label">{Math.round(zoomLevel * 100)}%</span>
          <button
            type="button"
            className="zoom-hud-btn"
            title="Zoom Out (Ctrl -)"
            onClick={() => triggerZoomChange(-0.1)}
          >
            -
          </button>
          <button
            type="button"
            className="zoom-hud-btn"
            title="Zoom In (Ctrl +)"
            onClick={() => triggerZoomChange(0.1)}
          >
            +
          </button>
          {zoomLevel !== 1.0 && (
            <button
              type="button"
              className="zoom-hud-btn"
              title="Reset Zoom (Ctrl 0)"
              onClick={() => triggerZoomChange('reset')}
            >
              100%
            </button>
          )}
        </div>
      )}

      {/* 12. Table of Contents (TOC) Floating Panel */}
      {showToc && (
        <div className="mhz-md-toc-panel">
          <div className="mhz-md-toc-header">
            <div className="mhz-md-toc-title">
              <ListTree size={15} className="mhz-md-toc-icon" />
              <span>Table of Contents</span>
              <span className="mhz-md-toc-count">{tocItems.length}</span>
            </div>
            <button
              type="button"
              className="mhz-md-toc-close-btn"
              onClick={() => setShowToc(false)}
              title="Close TOC (Alt+T / ESC)"
            >
              <X size={14} />
            </button>
          </div>

          {tocItems.length > 6 && (
            <div className="mhz-md-toc-search-bar">
              <Search size={13} className="mhz-md-toc-search-icon" />
              <input
                type="text"
                className="mhz-md-toc-search-input"
                placeholder="Filter headings..."
                value={tocFilter}
                onChange={(e) => setTocFilter(e.target.value)}
              />
              {tocFilter && (
                <button
                  type="button"
                  className="mhz-md-toc-search-clear"
                  onClick={() => setTocFilter('')}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )}

          <div className="mhz-md-toc-body">
            {filteredTocItems.length === 0 ? (
              <div className="mhz-md-toc-empty">
                {tocItems.length === 0 ? 'No headings found (# Heading)' : 'No matching headings'}
              </div>
            ) : (
              filteredTocItems.map((item, idx) => (
                <button
                  key={item.id || idx}
                  type="button"
                  className={`mhz-md-toc-item level-${item.level}`}
                  style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }}
                  onClick={() => handleJumpToHeading(item, idx)}
                  title={`H${item.level}: ${item.text}`}
                >
                  <span className={`mhz-md-toc-level-tag h${item.level}`}>H{item.level}</span>
                  <span className="mhz-md-toc-item-text">{item.text}</span>
                </button>
              ))
            )}
          </div>

          <div className="mhz-md-toc-footer">
            <span>Shortcut: <strong>Alt+T</strong></span>
          </div>
        </div>
      )}
    </div>
  );
};

export default MarkdownEditor;
