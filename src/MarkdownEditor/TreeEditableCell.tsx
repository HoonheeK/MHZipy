import React, { useRef, useCallback, useState, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  GripVertical,
  CheckSquare,
  Square,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  List,
  ListOrdered,
  Quote,
  Minus,
  AlignLeft,
  AlignCenter,
  AlignRight,
  CornerDownLeft,
  Table as TableIcon,
  Palette,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Eraser,
  Type,
  Crop,
  FolderOpen,
  RotateCcw
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { writeFile, readFile } from '@tauri-apps/plugin-fs';
import {
  Block,
  BlockType,
  generateId,
  getBlockClassName,
  htmlToMarkdown,
  serializeBlocksToMarkdown,
  parseMarkdownToBlocks,
  renderImageHtml,
  parseImageHash
} from './markdownBlockUtils';

// --- List Marker Component (from TreeDiadev's EditableCell) ---
export const ListMarker: React.FC<{
  type: BlockType;
  listType?: 'ul' | 'ol';
  indent: number;
  index: number;
  blocks: Block[];
}> = ({ type, listType, indent, index, blocks }) => {
  if (type !== 'list') return null;

  if (listType === 'ol') {
    // Calculate 1-indexed count among contiguous ol items at same indent
    let count = 1;
    for (let i = index - 1; i >= 0; i--) {
      const prev = blocks[i];
      if (prev.indent < indent) break;
      if (prev.indent === indent) {
        if (prev.type === 'list' && prev.listType === 'ol') count++;
        else break;
      }
    }
    return <span className="mhz-td-list-marker ol">{count}.</span>;
  }

  // UL marker
  return <span className="mhz-td-list-marker ul">•</span>;
};

// --- ContentBlock Component (from TreeDiadev's ContentBlock with cursor preservation) ---
export const ContentBlock = React.memo<{
  id: string;
  dataBlockId: string;
  html: string;
  className: string;
  isEditing: boolean;
  style?: React.CSSProperties;
  onInput: (e: React.FormEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onFocus: (e: React.FocusEvent<HTMLDivElement>) => void;
  onBlur: (e: React.FocusEvent<HTMLDivElement>) => void;
  onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseUp?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseDown?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseMove?: (e: React.MouseEvent<HTMLDivElement>) => void;
}>(({
  id,
  dataBlockId,
  html,
  className,
  isEditing,
  style,
  onInput,
  onKeyDown,
  onFocus,
  onBlur,
  onClick,
  onContextMenu,
  onMouseUp,
  onMouseDown,
  onMouseMove
}) => {
  const contentEditableRef = useRef<HTMLDivElement>(null);

  // Synchronously update innerHTML only if different, preventing cursor jumps
  useLayoutEffect(() => {
    if (contentEditableRef.current && contentEditableRef.current.innerHTML !== html) {
      contentEditableRef.current.innerHTML = html;
    }
  }, [html]);

  return (
    <div
      ref={contentEditableRef}
      id={id}
      data-block-id={dataBlockId}
      className={className}
      style={style}
      contentEditable={isEditing}
      suppressContentEditableWarning
      onInput={onInput}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseUp={onMouseUp}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
    />
  );
});

// Helper to determine caret offset within contentEditable element
const getCaretOffset = (element: HTMLElement): number => {
  let caretOffset = 0;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (element.contains(range.endContainer)) {
      const preCaretRange = range.cloneRange();
      preCaretRange.selectNodeContents(element);
      preCaretRange.setEnd(range.endContainer, range.endOffset);
      caretOffset = preCaretRange.toString().length;
    }
  }
  return caretOffset;
};

// Helper to inspect the text right before the caret for a slash command trigger
export const getSlashQueryAtCaret = (element: HTMLElement): { isSlashActive: boolean; query: string } => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { isSlashActive: false, query: '' };
  const range = sel.getRangeAt(0);
  if (!element.contains(range.startContainer)) return { isSlashActive: false, query: '' };

  const preCaretRange = range.cloneRange();
  preCaretRange.selectNodeContents(element);
  preCaretRange.setEnd(range.startContainer, range.startOffset);
  const textBeforeCaret = preCaretRange.toString().replace(/\u200B/g, '');

  const lastSlashIndex = textBeforeCaret.lastIndexOf('/');
  if (lastSlashIndex === -1) return { isSlashActive: false, query: '' };

  // If there are characters before '/', the slash must be preceded by whitespace or be at start
  if (lastSlashIndex > 0) {
    const charBefore = textBeforeCaret[lastSlashIndex - 1];
    if (charBefore !== ' ' && charBefore !== '\n' && charBefore !== '\t' && charBefore !== '\u00A0') {
      return { isSlashActive: false, query: '' };
    }
  }

  const query = textBeforeCaret.slice(lastSlashIndex + 1);
  if (/\s/.test(query)) return { isSlashActive: false, query: '' };

  return { isSlashActive: true, query };
};

// Focus a specific block by ID and set caret position
const focusBlock = (blockId: string, caretOffset: number = 0) => {
  setTimeout(() => {
    const el = document.getElementById(`edit-${blockId}`);
    if (!el) return;
    el.focus();

    const sel = window.getSelection();
    const range = document.createRange();
    try {
      if (caretOffset === 0 || !el.firstChild) {
        range.selectNodeContents(el);
        range.collapse(true);
      } else if (caretOffset === -1) {
        range.selectNodeContents(el);
        range.collapse(false);
      } else {
        let currentOffset = 0;
        let targetNode: Node = el;
        let targetOffset = 0;

        const walk = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const len = node.textContent?.length || 0;
            if (currentOffset + len >= caretOffset) {
              targetNode = node;
              targetOffset = caretOffset - currentOffset;
              return true;
            }
            currentOffset += len;
          } else {
            for (const child of Array.from(node.childNodes)) {
              if (walk(child)) return true;
            }
          }
          return false;
        };

        walk(el);
        range.setStart(targetNode, targetOffset);
        range.collapse(true);
      }

      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {}
  }, 10);
};

// Focus a specific table cell element and select contents or place caret
const focusCell = (cellElement: HTMLElement, mode: 'all' | 'start' | 'end' | boolean = 'all') => {
  cellElement.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(cellElement);
  if (mode === 'start') {
    range.collapse(true);
  } else if (mode === 'end' || mode === false) {
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
};

// Get caret position information inside an editable table cell
const getCellCaretInfo = (cell: HTMLElement) => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return { offset: 0, length: 0, isAtStart: true, isAtEnd: true, hasSelection: false };
  }

  if (!sel.isCollapsed) {
    return { offset: 0, length: 0, isAtStart: false, isAtEnd: false, hasSelection: true };
  }

  const text = (cell.textContent || '').replace(/\u200B/g, '');
  const length = text.length;

  if (length === 0) {
    return { offset: 0, length: 0, isAtStart: true, isAtEnd: true, hasSelection: false };
  }

  const range = sel.getRangeAt(0);
  const preRange = range.cloneRange();
  preRange.selectNodeContents(cell);
  preRange.setEnd(range.startContainer, range.startOffset);
  const offset = (preRange.toString() || '').replace(/\u200B/g, '').length;

  return {
    offset,
    length,
    isAtStart: offset === 0,
    isAtEnd: offset >= length,
    hasSelection: false
  };
};

// Preset Color Palettes (identical to TreeDiadev's MarkdownComp)
export const TEXT_COLORS_DARK = ['#ffffff', '#f87171', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa'];
export const BG_COLORS_DARK = ['#374151', '#7f1d1d', '#1e3a8a', '#064e3b', '#78350f', '#4c1d95'];

// Convert a rendered Block into raw Markdown string for F2 editing
export const toRawMarkdown = (b: Block, baseDir?: string): string => {
  if (b.type === 'divider') return '---';

  // Special handling for image blocks to cleanly extract relative path & preserve hash parameters (#crop, #width)
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = b.html;
  const images = tempDiv.querySelectorAll('img');
  const hasOtherText = (tempDiv.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() !== '';

  if (images.length === 1 && !hasOtherText) {
    const img = images[0];
    const alt = img.getAttribute('alt') || '';
    let originalSrc = img.getAttribute('data-original-src') || img.getAttribute('src') || '';
    const title = img.getAttribute('title');

    // Decode asset.localhost URL if needed
    if (originalSrc.startsWith('http://asset.localhost/') || originalSrc.startsWith('https://asset.localhost/')) {
      try {
        const u = new URL(originalSrc);
        let p = decodeURIComponent(u.pathname);
        if (/^\/[a-zA-Z]:/.test(p)) p = p.substring(1);
        originalSrc = p + (u.hash || '');
      } catch {}
    }

    let [cleanPath, existingHash] = originalSrc.split('#');
    let hash = existingHash ? `#${existingHash}` : '';

    // Check data-crop-rect or data-custom-width
    const cropRect = img.getAttribute('data-crop-rect') || img.closest('span[data-crop-rect]')?.getAttribute('data-crop-rect');
    const customWidth = img.getAttribute('data-custom-width') || img.closest('span[data-custom-width]')?.getAttribute('data-custom-width');

    const hashParams = new URLSearchParams(existingHash || '');
    let hashChanged = false;
    if (cropRect) {
      if (hashParams.get('crop') !== cropRect) {
        hashParams.set('crop', cropRect);
        hashChanged = true;
      }
    }
    if (customWidth) {
      if (hashParams.get('width') !== customWidth) {
        hashParams.set('width', customWidth);
        hashChanged = true;
      }
    }
    if (hashChanged) {
      const rawHash = hashParams.toString();
      hash = rawHash ? `#${decodeURIComponent(rawHash)}` : '';
    }

    let finalPath = cleanPath;
    if (baseDir && (cleanPath.includes(':') || cleanPath.startsWith('/') || cleanPath.startsWith('\\'))) {
      const normPath = cleanPath.replace(/\\/g, '/');
      const normBase = baseDir.replace(/\\/g, '/');
      if (normPath.toLowerCase().startsWith(normBase.toLowerCase())) {
        let rel = normPath.substring(normBase.length).replace(/^\/+/, '');
        finalPath = `./${rel}`;
      }
    }

    const titlePart = title ? ` "${title}"` : '';
    const mdContent = `![${alt}](${finalPath}${hash}${titlePart})`;

    switch (b.type) {
      case 'h1': return `# ${mdContent}`;
      case 'h2': return `## ${mdContent}`;
      case 'h3': return `### ${mdContent}`;
      case 'h4': return `#### ${mdContent}`;
      case 'h5': return `##### ${mdContent}`;
      case 'h6': return `###### ${mdContent}`;
      case 'quote': return `> ${mdContent}`;
      case 'list': return b.listType === 'ol' ? `1. ${mdContent}` : `- ${mdContent}`;
      case 'checkbox': return `[${b.checked ? 'x' : ' '}] ${mdContent}`;
      default: return mdContent;
    }
  }

  const md = htmlToMarkdown(b.html, baseDir);
  switch (b.type) {
    case 'h1': return `# ${md}`;
    case 'h2': return `## ${md}`;
    case 'h3': return `### ${md}`;
    case 'h4': return `#### ${md}`;
    case 'h5': return `##### ${md}`;
    case 'h6': return `###### ${md}`;
    case 'quote': return `> ${md}`;
    case 'list': {
      const cleanMd = md.replace(/^([-*+]|\d+\.)\s+/, '');
      return b.listType === 'ol' ? `1. ${cleanMd}` : `- ${cleanMd}`;
    }
    case 'checkbox': {
      const cleanMd = md.replace(/^\[[ xX]\]\s+/, '');
      return b.checked ? `[x] ${cleanMd}` : `[ ] ${cleanMd}`;
    }
    case 'code': return `\`\`\`\n${md}\n\`\`\``;
    case 'table': return md;
    default: return md;
  }
};

// Convert raw Markdown text back into a Block structure using full parser with baseDir
export const fromRawMarkdown = (rawText: string, currentBlock: Block, baseDir?: string): Partial<Block> => {
  const trimmed = rawText.trim();
  const parsed = parseMarkdownToBlocks(trimmed, baseDir);
  if (parsed.length > 0) {
    const first = parsed[0];
    return {
      type: first.type,
      html: first.html,
      checked: first.checked,
      listType: first.listType,
      isRaw: false
    };
  }
  return {
    type: currentBlock.type === 'divider' ? 'paragraph' : currentBlock.type,
    html: '',
    isRaw: false
  };
};

// Helper to determine the cumulative CSS zoom of an element (handles editor zoom)
export const getElementZoom = (el: HTMLElement | null): number => {
  let zoom = 1;
  let curr: HTMLElement | null = el;
  while (curr && curr !== document.documentElement) {
    const styleZoom = (curr.style as any)?.zoom || window.getComputedStyle(curr).zoom;
    if (styleZoom) {
      const z = parseFloat(styleZoom);
      if (!isNaN(z) && z > 0) {
        zoom *= z;
      }
    }
    curr = curr.parentElement;
  }
  return zoom || 1;
};

// --- In-Place Image Crop Overlay Component (Directly in Editor, no modal popup) ---
export interface CropArea {
  unit: '%' | 'px';
  x: number;
  y: number;
  width: number;
  height: number;
}

type DragMode = 'new' | 'move' | 'nw' | 'ne' | 'se' | 'sw' | null;

export interface InPlaceCropOverlayProps {
  blockId: string;
  target: HTMLImageElement;
  src: string;
  originalSrc: string;
  currentScale?: number;
  baseDir?: string;
  onClose: () => void;
  onResetCrop?: () => void;
  onApplyCrop: (cropPx: { x: number; y: number; width: number; height: number }, targetWidth?: number) => void;
  onSaveAsFile?: (newRelPath: string, targetWidth?: number) => void;
}

export const InPlaceCropOverlay: React.FC<InPlaceCropOverlayProps> = ({
  target,
  originalSrc,
  currentScale,
  baseDir,
  onClose,
  onResetCrop,
  onApplyCrop,
  onSaveAsFile
}) => {
  const cropWrapper = target.closest('span[data-crop-rect]') as HTMLElement | null;
  const rectTarget = cropWrapper || target;

  // Check if target is already cropped
  const rawCropAttr = (cropWrapper || target).getAttribute('data-crop-rect')?.split(',').map(Number);
  const isAlreadyCropped = Boolean(
    rawCropAttr &&
    rawCropAttr.length === 4 &&
    !rawCropAttr.some(isNaN) &&
    rawCropAttr[2] > 0 &&
    rawCropAttr[3] > 0
  );

  const baseX = isAlreadyCropped ? rawCropAttr![0] : 0;
  const baseY = isAlreadyCropped ? rawCropAttr![1] : 0;
  const baseWidth = isAlreadyCropped ? rawCropAttr![2] : (target.naturalWidth || Math.round(rectTarget.getBoundingClientRect().width));
  const baseHeight = isAlreadyCropped ? rawCropAttr![3] : (target.naturalHeight || Math.round(rectTarget.getBoundingClientRect().height));

  // Initialize crop:
  // If already cropped: 100% full (covering the entire currently visible cropped image)
  // If not cropped: 80% center by default
  const [crop, setCrop] = useState<CropArea>(() => {
    if (isAlreadyCropped) {
      return { unit: '%', x: 0, y: 0, width: 100, height: 100 };
    }
    return { unit: '%', x: 10, y: 10, width: 80, height: 80 };
  });

  const isScaled = typeof currentScale === 'number' && currentScale > 0 && Math.abs(currentScale - 1) > 0.02;
  const [keepReducedScale, setKeepReducedScale] = useState<boolean>(isScaled);

  // Position tracking state updated every frame via requestAnimationFrame
  const [targetRect, setTargetRect] = useState<DOMRect>(() => rectTarget.getBoundingClientRect());

  useEffect(() => {
    let rafId: number;
    let isMounted = true;
    const updateRect = () => {
      if (!isMounted) return;
      if (!document.body.contains(rectTarget)) {
        onClose();
        return;
      }
      const r = rectTarget.getBoundingClientRect();
      setTargetRect(r);
      rafId = requestAnimationFrame(updateRect);
    };
    rafId = requestAnimationFrame(updateRect);
    return () => {
      isMounted = false;
      cancelAnimationFrame(rafId);
    };
  }, [rectTarget, onClose]);

  // Dragging logic
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const dragStartRef = useRef<{
    clientX: number;
    clientY: number;
    startCrop: CropArea;
    rect: DOMRect;
  } | null>(null);

  const startDrag = (mode: DragMode, clientX: number, clientY: number) => {
    const r = rectTarget.getBoundingClientRect();
    dragStartRef.current = {
      clientX,
      clientY,
      startCrop: { ...crop },
      rect: r
    };
    setDragMode(mode);
  };

  const handleContainerMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = rectTarget.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const clickPctX = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    const clickPctY = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
    setCrop({ unit: '%', x: clickPctX, y: clickPctY, width: 0, height: 0 });
    startDrag('new', e.clientX, e.clientY);
  };

  useEffect(() => {
    if (!dragMode) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const { clientX: startClientX, clientY: startClientY, startCrop, rect: startRect } = dragStartRef.current;
      if (startRect.width <= 0 || startRect.height <= 0) return;

      const deltaPctX = ((e.clientX - startClientX) / startRect.width) * 100;
      const deltaPctY = ((e.clientY - startClientY) / startRect.height) * 100;

      if (dragMode === 'move') {
        const maxX = Math.max(0, 100 - startCrop.width);
        const maxY = Math.max(0, 100 - startCrop.height);
        const newX = Math.max(0, Math.min(maxX, startCrop.x + deltaPctX));
        const newY = Math.max(0, Math.min(maxY, startCrop.y + deltaPctY));
        setCrop({ ...startCrop, x: newX, y: newY });
      } else if (dragMode === 'new') {
        const curPctX = Math.max(0, Math.min(100, ((e.clientX - startRect.left) / startRect.width) * 100));
        const curPctY = Math.max(0, Math.min(100, ((e.clientY - startRect.top) / startRect.height) * 100));
        const x = Math.min(startCrop.x, curPctX);
        const y = Math.min(startCrop.y, curPctY);
        const width = Math.abs(curPctX - startCrop.x);
        const height = Math.abs(curPctY - startCrop.y);
        setCrop({ unit: '%', x, y, width, height });
      } else if (dragMode === 'se') {
        const newW = Math.max(2, Math.min(100 - startCrop.x, startCrop.width + deltaPctX));
        const newH = Math.max(2, Math.min(100 - startCrop.y, startCrop.height + deltaPctY));
        setCrop({ ...startCrop, width: newW, height: newH });
      } else if (dragMode === 'sw') {
        const rightEdge = startCrop.x + startCrop.width;
        const newX = Math.max(0, Math.min(rightEdge - 2, startCrop.x + deltaPctX));
        const newW = rightEdge - newX;
        const newH = Math.max(2, Math.min(100 - startCrop.y, startCrop.height + deltaPctY));
        setCrop({ ...startCrop, x: newX, width: newW, height: newH });
      } else if (dragMode === 'ne') {
        const bottomEdge = startCrop.y + startCrop.height;
        const newY = Math.max(0, Math.min(bottomEdge - 2, startCrop.y + deltaPctY));
        const newH = bottomEdge - newY;
        const newW = Math.max(2, Math.min(100 - startCrop.x, startCrop.width + deltaPctX));
        setCrop({ ...startCrop, y: newY, width: newW, height: newH });
      } else if (dragMode === 'nw') {
        const rightEdge = startCrop.x + startCrop.width;
        const bottomEdge = startCrop.y + startCrop.height;
        const newX = Math.max(0, Math.min(rightEdge - 2, startCrop.x + deltaPctX));
        const newY = Math.max(0, Math.min(bottomEdge - 2, startCrop.y + deltaPctY));
        const newW = rightEdge - newX;
        const newH = bottomEdge - newY;
        setCrop({ ...startCrop, x: newX, y: newY, width: newW, height: newH });
      }
    };

    const handleMouseUp = () => {
      setDragMode(null);
      dragStartRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragMode]);

  const handleApplyTrim = () => {
    if (baseWidth > 0 && baseHeight > 0 && crop.width > 0 && crop.height > 0) {
      const finalCropX = Math.max(0, Math.round(baseX + (crop.x / 100) * baseWidth));
      const finalCropY = Math.max(0, Math.round(baseY + (crop.y / 100) * baseHeight));
      const finalCropW = Math.max(1, Math.round((crop.width / 100) * baseWidth));
      const finalCropH = Math.max(1, Math.round((crop.height / 100) * baseHeight));

      const finalCropPx = {
        x: finalCropX,
        y: finalCropY,
        width: finalCropW,
        height: finalCropH
      };
      const targetWidth = keepReducedScale && currentScale && Math.abs(currentScale - 1) > 0.02
        ? Math.round(finalCropPx.width * currentScale)
        : undefined;
      onApplyCrop(finalCropPx, targetWidth);
    }
    onClose();
  };

  const handleSaveCroppedFile = async () => {
    if (!baseDir || crop.width <= 0 || crop.height <= 0 || baseWidth <= 0 || baseHeight <= 0) {
      handleApplyTrim();
      return;
    }
    try {
      const cropX = Math.max(0, Math.round(baseX + (crop.x / 100) * baseWidth));
      const cropY = Math.max(0, Math.round(baseY + (crop.y / 100) * baseHeight));
      const cropW = Math.max(1, Math.round((crop.width / 100) * baseWidth));
      const cropH = Math.max(1, Math.round((crop.height / 100) * baseHeight));

      if (cropW <= 0 || cropH <= 0) return;

      const canvas = document.createElement('canvas');
      canvas.width = cropW;
      canvas.height = cropH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      let cleanSrc = originalSrc.split('#')[0].split('?')[0];
      if (cleanSrc.startsWith('http://asset.localhost') || cleanSrc.startsWith('https://asset.localhost') || cleanSrc.startsWith('asset://')) {
        try {
          const u = new URL(cleanSrc);
          let p = decodeURIComponent(u.pathname);
          p = p.replace(/^\/+([a-zA-Z]:)/, '$1');
          cleanSrc = p;
        } catch {}
      }
      cleanSrc = cleanSrc.replace(/^[/\\]*\?+[/\\]+/, '').replace(/^\\\\\?\\/, '');
      if (/^\/[a-zA-Z]:/.test(cleanSrc)) cleanSrc = cleanSrc.substring(1);

      let absSrcPath = cleanSrc;
      const isAbs = /^[a-zA-Z]:[/\\]/.test(cleanSrc) || cleanSrc.startsWith('\\\\');
      if (!isAbs && baseDir) {
        const cleanRel = cleanSrc.replace(/^\.[/\\]/, '');
        const cleanBase = baseDir.replace(/[/\\]+$/, '');
        absSrcPath = `${cleanBase}/${cleanRel}`;
      }
      absSrcPath = absSrcPath.replace(/\//g, '\\');

      let sourceImg: CanvasImageSource = target;
      let blobUrlToRevoke: string | null = null;

      try {
        const bytes = await readFile(absSrcPath);
        const ext = absSrcPath.split('.').pop()?.toLowerCase() || 'png';
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
        const fileBlob = new Blob([bytes], { type: mime });
        blobUrlToRevoke = URL.createObjectURL(fileBlob);
        const tempImg = new Image();
        await new Promise<void>((resolve, reject) => {
          tempImg.onload = () => resolve();
          tempImg.onerror = () => reject(new Error('Failed to load blob image'));
          tempImg.src = blobUrlToRevoke!;
        });
        sourceImg = tempImg;
      } catch (readErr) {
        console.warn('Could not read image file directly for canvas, using fallback element:', readErr);
      }

      ctx.drawImage(sourceImg, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      if (blobUrlToRevoke) {
        URL.revokeObjectURL(blobUrlToRevoke);
      }

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return;

      const arrayBuffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const newFileName = `image_crop_${timestamp}.png`;
      const cleanBase = baseDir.replace(/[/\\]+$/, '');
      const newAbsPath = `${cleanBase}/${newFileName}`;

      await writeFile(newAbsPath, uint8);
      const targetWidth = keepReducedScale && currentScale && Math.abs(currentScale - 1) > 0.02
        ? Math.round(cropW * currentScale)
        : undefined;
      if (onSaveAsFile) {
        onSaveAsFile(`./${newFileName}`, targetWidth);
      }
      onClose();
    } catch (err) {
      console.error('Failed to save cropped image file:', err);
      handleApplyTrim();
    }
  };

  // Keyboard navigation (Escape to cancel, Enter to apply)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        handleApplyTrim();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  });

  // Calculate toolbar placement directly below image
  let toolbarTop = targetRect.bottom + 6;
  if (toolbarTop + 45 > window.innerHeight && targetRect.top > 50) {
    toolbarTop = Math.max(8, targetRect.top - 44);
  }
  const toolbarLeft = Math.max(16, Math.min(targetRect.left, window.innerWidth - 720));

  return createPortal(
    <>
      {/* In-Place Crop Box directly overlaying the image in editor */}
      <div
        style={{
          position: 'fixed',
          top: `${targetRect.top}px`,
          left: `${targetRect.left}px`,
          width: `${targetRect.width}px`,
          height: `${targetRect.height}px`,
          zIndex: 99998,
          pointerEvents: 'auto',
          cursor: 'crosshair',
          userSelect: 'none',
          boxSizing: 'border-box'
        }}
        onMouseDown={handleContainerMouseDown}
      >
        {/* Darkened mask outside crop selection */}
        {crop.width > 0 && crop.height > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              backgroundColor: 'rgba(0, 0, 0, 0.55)',
              clipPath: `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${crop.x}% ${crop.y}%, ${crop.x}% ${crop.y + crop.height}%, ${crop.x + crop.width}% ${crop.y + crop.height}%, ${crop.x + crop.width}% ${crop.y}%, ${crop.x}% ${crop.y}%)`,
              pointerEvents: 'none'
            }}
          />
        )}

        {/* Active Crop Box with Handles */}
        {crop.width > 0 && crop.height > 0 && (
          <div
            style={{
              position: 'absolute',
              left: `${crop.x}%`,
              top: `${crop.y}%`,
              width: `${crop.width}%`,
              height: `${crop.height}%`,
              border: '2px dashed #3b82f6',
              boxShadow: '0 0 0 1px rgba(0,0,0,0.85)',
              backgroundColor: 'rgba(59, 130, 246, 0.12)',
              cursor: 'move',
              pointerEvents: 'auto',
              boxSizing: 'border-box'
            }}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              startDrag('move', e.clientX, e.clientY);
            }}
          >
            {/* Dimensions Badge */}
            <div
              style={{
                position: 'absolute',
                top: -24,
                left: 0,
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                color: '#fff',
                fontSize: '11px',
                padding: '2px 6px',
                borderRadius: '3px',
                whiteSpace: 'nowrap',
                fontWeight: 600,
                pointerEvents: 'none',
                boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
                border: '1px solid rgba(255,255,255,0.1)'
              }}
            >
              {Math.max(1, Math.round((crop.width / 100) * baseWidth))} × {Math.max(1, Math.round((crop.height / 100) * baseHeight))} px{currentScale && Math.abs(currentScale - 1) > 0.02 ? ` (${Math.round(currentScale * 100)}%)` : ''}
            </div>

            {/* Corner Handles */}
            <div
              style={{
                position: 'absolute',
                top: -5,
                left: -5,
                width: 10,
                height: 10,
                background: '#ffffff',
                border: '2px solid #2563eb',
                borderRadius: 2,
                cursor: 'nwse-resize',
                pointerEvents: 'auto'
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                startDrag('nw', e.clientX, e.clientY);
              }}
            />
            <div
              style={{
                position: 'absolute',
                top: -5,
                right: -5,
                width: 10,
                height: 10,
                background: '#ffffff',
                border: '2px solid #2563eb',
                borderRadius: 2,
                cursor: 'nesw-resize',
                pointerEvents: 'auto'
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                startDrag('ne', e.clientX, e.clientY);
              }}
            />
            <div
              style={{
                position: 'absolute',
                bottom: -5,
                right: -5,
                width: 10,
                height: 10,
                background: '#ffffff',
                border: '2px solid #2563eb',
                borderRadius: 2,
                cursor: 'nwse-resize',
                pointerEvents: 'auto'
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                startDrag('se', e.clientX, e.clientY);
              }}
            />
            <div
              style={{
                position: 'absolute',
                bottom: -5,
                left: -5,
                width: 10,
                height: 10,
                background: '#ffffff',
                border: '2px solid #2563eb',
                borderRadius: 2,
                cursor: 'nesw-resize',
                pointerEvents: 'auto'
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                startDrag('sw', e.clientX, e.clientY);
              }}
            />
          </div>
        )}
      </div>

      {/* In-Place Crop Action Toolbar directly below image */}
      <div
        className="mhz-td-image-toolbar mhz-td-in-place-crop-toolbar"
        style={{
          position: 'fixed',
          top: `${toolbarTop}px`,
          left: `${toolbarLeft}px`,
          zIndex: 99999,
          display: 'flex',
          alignItems: 'center',
          gap: '4px'
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider px-1">CROP</span>
        <div className="mhz-td-image-toolbar-sep" />

        {/* Presets */}
        <button
          type="button"
          className="mhz-td-image-toolbar-btn text-[11px]"
          onClick={() => setCrop({ unit: '%', x: 0, y: 0, width: 100, height: 100 })}
          title="Reset to 100% full image"
        >
          100% Full
        </button>
        <button
          type="button"
          className="mhz-td-image-toolbar-btn text-[11px]"
          onClick={() => setCrop({ unit: '%', x: 10, y: 10, width: 80, height: 80 })}
          title="Center 80%"
        >
          80% Center
        </button>
        <button
          type="button"
          className="mhz-td-image-toolbar-btn text-[11px]"
          onClick={() => {
            if (baseWidth > 0 && baseHeight > 0) {
              const minSide = Math.min(baseWidth, baseHeight);
              const wPct = (minSide / baseWidth) * 80;
              const hPct = (minSide / baseHeight) * 80;
              setCrop({ unit: '%', x: (100 - wPct) / 2, y: (100 - hPct) / 2, width: wPct, height: hPct });
            } else {
              setCrop({ unit: '%', x: 10, y: 10, width: 80, height: 80 });
            }
          }}
          title="1:1 Square"
        >
          1:1 Square
        </button>

        {/* Reset Crop (if already cropped) */}
        {isAlreadyCropped && onResetCrop && (
          <button
            type="button"
            className="mhz-td-image-toolbar-btn text-amber-400 hover:text-amber-300"
            onClick={() => {
              onResetCrop();
              onClose();
            }}
            title="Reset crop to full original image"
          >
            <RotateCcw size={13} />
            <span>Reset Crop</span>
          </button>
        )}

        {/* Keep Scale Checkbox (if image was scaled) */}
        {isScaled && (
          <>
            <div className="mhz-td-image-toolbar-sep" />
            <label className="flex items-center gap-1.5 text-[11px] text-blue-300 font-medium cursor-pointer select-none px-1">
              <input
                type="checkbox"
                checked={keepReducedScale}
                onChange={(e) => setKeepReducedScale(e.target.checked)}
                className="rounded border-slate-600 text-blue-500 focus:ring-0 cursor-pointer"
              />
              <span>Keep Scale ({Math.round(currentScale! * 100)}%)</span>
            </label>
          </>
        )}

        <div className="mhz-td-image-toolbar-sep" />

        {/* Cancel button */}
        <button
          type="button"
          className="mhz-td-image-toolbar-btn"
          onClick={onClose}
          title="Cancel Crop (Esc)"
        >
          Cancel
        </button>

        {/* Save as File button */}
        {baseDir && (
          <button
            type="button"
            className="mhz-td-image-toolbar-btn text-emerald-400 hover:text-emerald-300"
            onClick={handleSaveCroppedFile}
            title="Save cropped area as new PNG file"
          >
            <FolderOpen size={13} />
            <span>Save as File</span>
          </button>
        )}

        {/* Apply Crop button */}
        <button
          type="button"
          className="mhz-td-image-toolbar-btn bg-blue-600 hover:bg-blue-500 text-white font-semibold px-2.5"
          onClick={handleApplyTrim}
          title="Apply non-destructive Crop (Enter)"
        >
          <Crop size={13} />
          <span>Apply Crop</span>
        </button>
      </div>
    </>,
    document.body
  );
};

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  type: BlockType;
  listType?: 'ul' | 'ol';
  shortcut: string;
  icon: React.ReactNode;
  defaultHtml?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'paragraph',
    label: 'Paragraph',
    description: 'Plain body text',
    type: 'paragraph',
    shortcut: 'P',
    icon: <AlignLeft size={15} />
  },
  {
    id: 'h1',
    label: 'Heading 1',
    description: 'Large section heading',
    type: 'h1',
    shortcut: '1',
    icon: <Heading1 size={15} />
  },
  {
    id: 'h2',
    label: 'Heading 2',
    description: 'Medium section heading',
    type: 'h2',
    shortcut: '2',
    icon: <Heading2 size={15} />
  },
  {
    id: 'h3',
    label: 'Heading 3',
    description: 'Small section heading',
    type: 'h3',
    shortcut: '3',
    icon: <Heading3 size={15} />
  },
  {
    id: 'h4',
    label: 'Heading 4',
    description: 'Sub-section heading',
    type: 'h4',
    shortcut: '4',
    icon: <Heading4 size={15} />
  },
  {
    id: 'h5',
    label: 'Heading 5',
    description: 'Minor section heading',
    type: 'h5',
    shortcut: '5',
    icon: <Heading5 size={15} />
  },
  {
    id: 'h6',
    label: 'Heading 6',
    description: 'Smallest section heading',
    type: 'h6',
    shortcut: '6',
    icon: <Heading6 size={15} />
  },
  {
    id: 'quote',
    label: 'Quote',
    description: 'Capture quote or callout',
    type: 'quote',
    shortcut: 'Q',
    icon: <Quote size={15} />
  },
  {
    id: 'bullet-list',
    label: 'Bullet List',
    description: 'Simple bulleted list',
    type: 'list',
    listType: 'ul',
    shortcut: 'L',
    icon: <List size={15} />
  },
  {
    id: 'numbered-list',
    label: 'Ordered List',
    description: 'Numbered ordered list',
    type: 'list',
    listType: 'ol',
    shortcut: 'O',
    icon: <ListOrdered size={15} />
  },
  {
    id: 'todo-list',
    label: 'To-do List',
    description: 'Task item with checkbox',
    type: 'checkbox',
    shortcut: 'V',
    icon: <CheckSquare size={15} />
  },
  {
    id: 'code',
    label: 'Code Block',
    description: 'Monospace code block',
    type: 'code',
    shortcut: 'K',
    icon: <Code2 size={15} />
  },
  {
    id: 'divider',
    label: 'Divider',
    description: 'Horizontal separator line',
    type: 'divider',
    shortcut: 'D',
    icon: <Minus size={15} />
  },
  {
    id: 'table',
    label: 'Table',
    description: 'Multi-column / multi-row table',
    type: 'table',
    shortcut: 'M',
    icon: <TableIcon size={15} />,
    defaultHtml: '<table><thead><tr><th>Header 1</th><th>Header 2</th><th>Header 3</th></tr></thead><tbody><tr><td>Item 1</td><td>Item 2</td><td>Item 3</td></tr><tr><td>Item 4</td><td>Item 5</td><td>Item 6</td></tr></tbody></table>'
  }
];

export interface MainMenuItem {
  id: string;
  label: string;
  desc?: string;
  shortcut: string;
  icon: React.ReactNode;
  isTurnInto?: boolean;
  isColors?: boolean;
  isTable?: boolean;
  cmdId?: string;
}

export const MAIN_MENU_ITEMS: MainMenuItem[] = [
  { id: 'turnInto', label: 'Turn into', desc: 'Transform block type', shortcut: 'T', icon: <Type size={13} />, isTurnInto: true },
  { id: 'colors', label: 'Colors', desc: 'Text & background color', shortcut: 'C', icon: <Palette size={13} />, isColors: true },
];

export const TURN_INTO_ITEMS: SlashCommand[] = [
  { id: 'paragraph', label: 'Paragraph', description: 'Plain text', type: 'paragraph', shortcut: 'P', icon: <AlignLeft size={13} /> },
  { id: 'h1', label: 'Heading 1', description: 'Large section heading', type: 'h1', shortcut: '1', icon: <Heading1 size={13} /> },
  { id: 'h2', label: 'Heading 2', description: 'Medium section heading', type: 'h2', shortcut: '2', icon: <Heading2 size={13} /> },
  { id: 'h3', label: 'Heading 3', description: 'Small section heading', type: 'h3', shortcut: '3', icon: <Heading3 size={13} /> },
  { id: 'h4', label: 'Heading 4', description: 'Sub-section heading', type: 'h4', shortcut: '4', icon: <Heading4 size={13} /> },
  { id: 'h5', label: 'Heading 5', description: 'Minor section heading', type: 'h5', shortcut: '5', icon: <Heading5 size={13} /> },
  { id: 'h6', label: 'Heading 6', description: 'Smallest section heading', type: 'h6', shortcut: '6', icon: <Heading6 size={13} /> },
  { id: 'quote', label: 'Quote', description: 'Capture quote or callout', type: 'quote', shortcut: 'Q', icon: <Quote size={13} /> },
  { id: 'bullet-list', label: 'Bullet List', description: 'Simple bulleted list', type: 'list', listType: 'ul', shortcut: 'L', icon: <List size={13} /> },
  { id: 'numbered-list', label: 'Ordered List', description: 'Numbered ordered list', type: 'list', listType: 'ol', shortcut: 'O', icon: <ListOrdered size={13} /> },
  { id: 'todo-list', label: 'To-do List', description: 'Task item with checkbox', type: 'checkbox', shortcut: 'V', icon: <CheckSquare size={13} /> },
  { id: 'code', label: 'Code Block', description: 'Monospace code snippet', type: 'code', shortcut: 'K', icon: <Code2 size={13} /> },
  { id: 'divider', label: 'Divider', description: 'Horizontal rule line', type: 'divider', shortcut: 'D', icon: <Minus size={13} /> },
  { id: 'table', label: 'Table', description: 'Markdown table', type: 'table', shortcut: 'T', icon: <TableIcon size={13} />, defaultHtml: '<table><thead><tr><th>Header 1</th><th>Header 2</th><th>Header 3</th></tr></thead><tbody><tr><td>Item 1</td><td>Item 2</td><td>Item 3</td></tr><tr><td>Item 4</td><td>Item 5</td><td>Item 6</td></tr></tbody></table>' },
];

export const getFilteredSlashCommands = (query: string): SlashCommand[] => {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(c =>
    c.label.toLowerCase().includes(q) ||
    c.description.toLowerCase().includes(q) ||
    c.shortcut.toLowerCase() === q ||
    c.type.toLowerCase().includes(q)
  );
};

export type MenuView = 'main' | 'turnInto' | 'colors';

export interface SlashMenuState {
  blockId: string;
  view: MenuView;
  selectedIndex: number;
  filterText: string;
}

export interface TableMenuState {
  x: number;
  y: number;
  blockId: string;
  rowIndex: number;
  colIndex: number;
  rowIndices: number[];
  colIndices: number[];
}

export interface TreeEditableCellProps {
  blocks: Block[];
  onUpdateBlocks: (newBlocks: Block[]) => void;
  fontSize: number;
  baseDir?: string;
}

/**
 * TreeDiadev-inspired EditableCell WYSIWYG Editor Component.
 * Supports typed blocks, contentEditable in-place editing, F2 markdown raw toggling,
 * ESC to exit edit mode, rich Slash ('/') menu with formatting, block conversion,
 * text/background color palettes, and image resizing & cropping.
 */
export const TreeEditableCell: React.FC<TreeEditableCellProps> = ({
  blocks,
  onUpdateBlocks,
  fontSize,
  baseDir
}) => {
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(new Set());
  const [lastAnchorBlockId, setLastAnchorBlockId] = useState<string | null>(null);
  const [collapsedHeadingIds, setCollapsedHeadingIds] = useState<Set<string>>(new Set());

  // Image interaction states (Selection toolbar, Resizing, and Cropping dialog)
  const [selectedImageInfo, setSelectedImageInfo] = useState<{
    blockId: string;
    target: HTMLImageElement;
    src: string;
    originalSrc: string;
  } | null>(null);

  const [trimmingImage, setTrimmingImage] = useState<{
    src: string;
    originalSrc: string;
    blockId: string;
    target: HTMLImageElement;
    currentScale?: number;
  } | null>(null);

  const [isResizingImage, setIsResizingImage] = useState(false);
  const resizeDragRef = useRef<{
    startX: number;
    startWidth: number;
    blockId: string;
    imgEl: HTMLImageElement;
    zoom?: number;
  } | null>(null);
  const lastAltArrowRef = useRef<{ key: 'ArrowLeft' | 'ArrowRight'; time: number; type: BlockType; blockId: string } | null>(null);
  const lastCtrlATimeRef = useRef<number>(0);
  const [gripMenuState, setGripMenuState] = useState<{ x: number; y: number; blockId: string } | null>(null);
  const [slashMenuState, setSlashMenuState] = useState<SlashMenuState | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<'bottom' | 'top'>('bottom');
  const [colorNav, setColorNav] = useState<{ col: 'text' | 'bg'; row: number }>({ col: 'text', row: 0 });
  const [contextMenuState, setContextMenuState] = useState<{ x: number; y: number; blockId: string } | null>(null);
  const [tableMenuState, setTableMenuState] = useState<TableMenuState | null>(null);
  const savedSelectionRef = useRef<{ range: Range; blockId: string } | null>(null);
  const isShiftSelectingRef = useRef<boolean>(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Block drag & drop states (supports single & multiple blocks via pointer events)
  const [draggedBlockIds, setDraggedBlockIds] = useState<Set<string> | null>(null);
  const [dropTarget, setDropTarget] = useState<{ blockId: string; placement: 'before' | 'after' } | null>(null);
  const [activeDragGhost, setActiveDragGhost] = useState<{
    x: number;
    y: number;
    count: number;
    label: string;
  } | null>(null);
  const pointerDragInfoRef = useRef<{
    sourceBlockId: string;
    blockIds: Set<string>;
    startX: number;
    startY: number;
    started: boolean;
  } | null>(null);

  const blocksRef = useRef<Block[]>(blocks);
  blocksRef.current = blocks;

  // Heading folding calculation:
  // H1 folds until next H1. H2 folds until next H1 or H2. H3 folds until next H1, H2, or H3.
  const getHeadingLevel = (type: BlockType): number => {
    if (type === 'h1') return 1;
    if (type === 'h2') return 2;
    if (type === 'h3') return 3;
    if (type === 'h4') return 4;
    if (type === 'h5') return 5;
    if (type === 'h6') return 6;
    return 999;
  };

  const hiddenBlockIds = React.useMemo(() => {
    const hidden = new Set<string>();
    if (collapsedHeadingIds.size === 0) return hidden;

    const stack: { id: string; level: number; isCollapsed: boolean }[] = [];
    for (const block of blocks) {
      const level = getHeadingLevel(block.type);
      if (level <= 6) {
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
          stack.pop();
        }
      }
      if (stack.some(h => h.isCollapsed)) {
        hidden.add(block.id);
      }
      if (level <= 3) {
        stack.push({
          id: block.id,
          level,
          isCollapsed: collapsedHeadingIds.has(block.id)
        });
      }
    }
    return hidden;
  }, [blocks, collapsedHeadingIds]);

  const toggleHeadingFold = useCallback((headingBlockId: string) => {
    setCollapsedHeadingIds(prev => {
      const next = new Set(prev);
      if (next.has(headingBlockId)) next.delete(headingBlockId);
      else next.add(headingBlockId);
      return next;
    });
  }, []);

  // Auto-adjust slash menu placement if close to bottom of screen
  useLayoutEffect(() => {
    if (!slashMenuState) return;
    const el = document.getElementById(`edit-${slashMenuState.blockId}`);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const approxHeight = slashMenuState.view === 'turnInto' ? 300 : slashMenuState.view === 'colors' ? 180 : 280;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow < approxHeight && spaceAbove > spaceBelow) {
      setMenuPlacement('top');
    } else {
      setMenuPlacement('bottom');
    }
  }, [slashMenuState?.blockId, slashMenuState?.view]);

  // Apply rich inline formatting (Bold, Italic, Underline, Strikethrough, RemoveFormat)
  const applyFormatting = useCallback((cmd: 'bold' | 'italic' | 'underline' | 'strikeThrough' | 'removeFormat', targetBlockId?: string) => {
    const blockId = targetBlockId || slashMenuState?.blockId || contextMenuState?.blockId;
    if (!blockId) return;
    const el = document.getElementById(`edit-${blockId}`);
    if (!el) return;

    // Restore saved selection range if available
    const sel = window.getSelection();
    if (savedSelectionRef.current && savedSelectionRef.current.blockId === blockId) {
      sel?.removeAllRanges();
      sel?.addRange(savedSelectionRef.current.range);
    }

    el.focus();
    document.execCommand(cmd, false);

    const current = blocksRef.current;
    const idx = current.findIndex(b => b.id === blockId);
    if (idx !== -1) {
      const next = [...current];
      next[idx] = { ...next[idx], html: el.innerHTML };
      onUpdateBlocks(next);
    }
  }, [slashMenuState, contextMenuState, onUpdateBlocks]);

  // Apply text or background color to selection or block
  const applyColor = useCallback((type: 'text' | 'bg', color: string, blockId: string) => {
    const current = blocksRef.current;
    const targetIds = selectedBlockIds.size > 1 && (selectedBlockIds.has(blockId) || !blockId)
      ? selectedBlockIds
      : null;

    // Apply color to all selected blocks
    if (targetIds) {
      const styleAttr = type === 'text'
        ? `color: ${color};`
        : `background-color: ${color}; padding: 2px 6px; border-radius: 4px;`;

      const next = current.map(b => {
        if (!targetIds.has(b.id)) return b;
        const c = document.getElementById(`edit-${b.id}`);
        let raw = (c ? c.innerHTML : b.html)
          .replace(/<span class="mhz-td-empty-hint">.*?<\/span>/gi, '')
          .replace(/\/([a-zA-Z0-9_\-]*)$/g, '')
          .replace(/^\/([a-zA-Z0-9_\-]*)/g, '')
          .replace(/\u200B/g, '')
          .trim();
        const innerContent = raw || '\u200B';
        const styledHtml = `<span style="${styleAttr}">${innerContent}</span>`;
        if (c) c.innerHTML = styledHtml;
        return { ...b, html: styledHtml, isRaw: false };
      });

      onUpdateBlocks(next);
      setSlashMenuState(null);
      setContextMenuState(null);
      return;
    }

    const idx = current.findIndex(b => b.id === blockId);
    if (idx === -1) return;
    const block = current[idx];
    const container = document.getElementById(`edit-${blockId}`);
    if (!container) return;

    // 1. Check if text is currently selected OR we have a saved range from right-click / selection
    let targetRange: Range | null = null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed && container.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      targetRange = sel.getRangeAt(0);
    } else if (savedSelectionRef.current && savedSelectionRef.current.blockId === blockId) {
      targetRange = savedSelectionRef.current.range;
    }

    if (targetRange && targetRange.toString().length > 0) {
      try {
        const span = document.createElement('span');
        if (type === 'text') {
          span.style.color = color;
        } else {
          span.style.backgroundColor = color;
          span.style.padding = '2px 4px';
          span.style.borderRadius = '3px';
        }
        const fragment = targetRange.extractContents();
        span.appendChild(fragment);
        targetRange.insertNode(span);

        savedSelectionRef.current = null;
        sel?.removeAllRanges();

        const next = [...current];
        next[idx] = { ...block, html: container.innerHTML, isRaw: false };
        onUpdateBlocks(next);
        setSlashMenuState(null);
        setContextMenuState(null);
        return;
      } catch (err) {
        console.warn('Range wrap error:', err);
      }
    }

    // 2. Otherwise apply style wrapper to whole block content
    let raw = container.innerHTML
      .replace(/<span class="mhz-td-empty-hint">.*?<\/span>/gi, '')
      .replace(/\/([a-zA-Z0-9_\-]*)$/g, '')
      .replace(/^\/([a-zA-Z0-9_\-]*)/g, '')
      .replace(/\u200B/g, '')
      .trim();

    const innerContent = raw || '\u200B';

    const styleAttr = type === 'text'
      ? `color: ${color};`
      : `background-color: ${color}; padding: 2px 6px; border-radius: 4px;`;

    const styledHtml = `<span style="${styleAttr}">${innerContent}</span>`;
    container.innerHTML = styledHtml;

    const next = [...current];
    next[idx] = { ...block, html: styledHtml, isRaw: false };
    onUpdateBlocks(next);
    setSlashMenuState(null);
    setContextMenuState(null);
    focusBlock(block.id, raw.length);
  }, [onUpdateBlocks, selectedBlockIds]);

  // Insert a clean 3x3 table
  const insertTable = useCallback((blockId: string) => {
    const current = blocksRef.current;
    const idx = current.findIndex(b => b.id === blockId);
    if (idx === -1) return;
    const tableHtml = `<table>
<thead>
<tr>
<th>Header 1</th>
<th>Header 2</th>
<th>Header 3</th>
</tr>
</thead>
<tbody>
<tr>
<td>Item 1</td>
<td>Item 2</td>
<td>Item 3</td>
</tr>
<tr>
<td>Item 4</td>
<td>Item 5</td>
<td>Item 6</td>
</tr>
</tbody>
</table>`;
    const next = [...current];
    next[idx] = {
      ...current[idx],
      type: 'table',
      html: tableHtml,
      isRaw: false
    };
    setSlashMenuState(null);
    onUpdateBlocks(next);
    setTimeout(() => {
      const el = document.getElementById(`edit-${blockId}`);
      const firstCell = el?.querySelector('th, td') as HTMLElement | null;
      if (firstCell) {
        focusCell(firstCell, 'all');
      } else {
        focusBlock(blockId, 0);
      }
    }, 20);
  }, [onUpdateBlocks]);

  // Handle Table row/column addition, deletion, and alignment (supports multi-cell selections)
  const handleTableAction = useCallback((
    blockId: string,
    action: 'add_row_above' | 'add_row_below' | 'del_row' | 'add_col_left' | 'add_col_right' | 'del_col' | 'add_row_bottom' | 'del_row_bottom' | 'add_col_right_btn' | 'del_col_right_btn' | 'align_col_left' | 'align_col_center' | 'align_col_right',
    targetRow?: number,
    targetCol?: number,
    targetRows?: number[],
    targetCols?: number[]
  ) => {
    const current = blocksRef.current;
    const idx = current.findIndex(b => b.id === blockId);
    if (idx === -1) return;

    const container = document.createElement('div');
    container.innerHTML = current[idx].html;
    const table = container.querySelector('table');
    if (!table) return;

    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return;
    const colCount = Math.max(1, rows[0].querySelectorAll('th, td').length);

    if (action === 'add_row_above' || action === 'add_row_below' || action === 'add_row_bottom') {
      const newTr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        const newTd = document.createElement('td');
        newTd.textContent = 'Item';
        newTr.appendChild(newTd);
      }
      if (action === 'add_row_above' && targetRow !== undefined && targetRow >= 0 && targetRow < rows.length) {
        rows[targetRow].parentElement?.insertBefore(newTr, rows[targetRow]);
      } else if (action === 'add_row_below' && targetRow !== undefined && targetRow >= 0 && targetRow < rows.length) {
        const next = rows[targetRow].nextElementSibling;
        if (next) rows[targetRow].parentElement?.insertBefore(newTr, next);
        else rows[targetRow].parentElement?.appendChild(newTr);
      } else {
        const tbody = table.querySelector('tbody') || table;
        tbody.appendChild(newTr);
      }
    } else if (action === 'del_row' || action === 'del_row_bottom') {
      if (rows.length <= 1) return; // Keep at least 1 row
      const rowsToDelete = targetRows && targetRows.length > 0
        ? [...targetRows].sort((a, b) => b - a)
        : (targetRow !== undefined && targetRow >= 0 && targetRow < rows.length ? [targetRow] : [rows.length - 1]);

      for (const rIdx of rowsToDelete) {
        const currRows = Array.from(table.querySelectorAll('tr'));
        if (currRows.length > 1 && rIdx >= 0 && rIdx < currRows.length) {
          currRows[rIdx].remove();
        }
      }
    } else if (action === 'add_col_left' || action === 'add_col_right' || action === 'add_col_right_btn') {
      const insertIdx = targetCol !== undefined ? (action === 'add_col_right' ? targetCol + 1 : targetCol) : colCount;
      rows.forEach((tr, rIdx) => {
        const cells = Array.from(tr.querySelectorAll('th, td'));
        const isHeader = rIdx === 0 || tr.parentElement?.tagName.toLowerCase() === 'thead';
        const newCell = document.createElement(isHeader ? 'th' : 'td');
        newCell.textContent = isHeader ? `Header ${cells.length + 1}` : 'Item';
        if (insertIdx < cells.length) {
          tr.insertBefore(newCell, cells[insertIdx]);
        } else {
          tr.appendChild(newCell);
        }
      });
    } else if (action === 'del_col' || action === 'del_col_right_btn') {
      if (colCount <= 1) return; // Keep at least 1 column
      const colsToDelete = targetCols && targetCols.length > 0
        ? [...targetCols].sort((a, b) => b - a)
        : (targetCol !== undefined ? [targetCol] : [colCount - 1]);

      for (const cIdx of colsToDelete) {
        const currColCount = Math.max(1, table.querySelectorAll('tr:first-child > *').length);
        if (currColCount > 1) {
          const currRows = Array.from(table.querySelectorAll('tr'));
          currRows.forEach(tr => {
            const cells = Array.from(tr.querySelectorAll('th, td'));
            if (cIdx < cells.length) {
              cells[cIdx].remove();
            }
          });
        }
      }
    } else if (action === 'align_col_left' || action === 'align_col_center' || action === 'align_col_right') {
      const alignVal = action === 'align_col_center' ? 'center' : (action === 'align_col_right' ? 'right' : 'left');
      const colsToAlign = targetCols && targetCols.length > 0
        ? targetCols
        : (targetCol !== undefined ? [targetCol] : [0]);

      rows.forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('th, td'));
        colsToAlign.forEach(cIdx => {
          if (cIdx >= 0 && cIdx < cells.length) {
            const targetCell = cells[cIdx] as HTMLElement;
            targetCell.setAttribute('align', alignVal);
            targetCell.style.textAlign = alignVal;
          }
        });
      });
    }

    const nextBlocks = [...current];
    nextBlocks[idx] = {
      ...current[idx],
      html: container.innerHTML
    };
    onUpdateBlocks(nextBlocks);
    setTableMenuState(null);
  }, [onUpdateBlocks]);

  // Handle saving selection on mouse up
  const handleBlockMouseUp = useCallback((blockId: string) => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const container = document.getElementById(`edit-${blockId}`);
      if (container && container.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        savedSelectionRef.current = {
          range: sel.getRangeAt(0).cloneRange(),
          blockId
        };
      }
    }
  }, []);

  const isResizingTableRef = useRef<boolean>(false);

  // Table column width resize hover detection
  const handleBlockMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>, _blockId: string) => {
    if (isResizingTableRef.current) return;
    const target = (e.target as HTMLElement).closest('th, td') as HTMLElement | null;
    const table = (e.target as HTMLElement).closest('table');
    if (!target || !table) return;

    const rect = target.getBoundingClientRect();
    const isRightBorder = Math.abs(e.clientX - rect.right) <= 6;
    if (isRightBorder) {
      target.style.cursor = 'col-resize';
    } else {
      target.style.cursor = '';
    }
  }, []);

  // Table column width resize drag start
  const handleBlockMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>, blockId: string) => {
    if (e.shiftKey) {
      e.preventDefault();
      handleSelectBlock(blockId, { shiftKey: true });
      return;
    }

    const target = (e.target as HTMLElement).closest('th, td') as HTMLTableCellElement | null;
    const table = (e.target as HTMLElement).closest('table');
    if (!target || !table) return;

    const rect = target.getBoundingClientRect();
    const isRightBorder = Math.abs(e.clientX - rect.right) <= 6;
    if (!isRightBorder) return;

    e.preventDefault();
    e.stopPropagation();

    isResizingTableRef.current = true;
    const startX = e.clientX;
    const startWidth = rect.width;
    const colIndex = target.cellIndex;

    document.body.style.cursor = 'col-resize';
    target.classList.add('mhz-td-col-resizing');

    const onMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const diff = moveEvent.clientX - startX;
      const newWidth = Math.max(45, Math.round(startWidth + diff));

      const allThs = Array.from(table.querySelectorAll('th'));
      if (colIndex < allThs.length) {
        allThs[colIndex].style.width = `${newWidth}px`;
        allThs[colIndex].style.minWidth = `${newWidth}px`;
      } else {
        const firstRowCells = table.querySelectorAll('tr:first-child > *');
        if (firstRowCells[colIndex]) {
          (firstRowCells[colIndex] as HTMLElement).style.width = `${newWidth}px`;
          (firstRowCells[colIndex] as HTMLElement).style.minWidth = `${newWidth}px`;
        }
      }
    };

    const onMouseUp = () => {
      isResizingTableRef.current = false;
      document.body.style.cursor = '';
      target.classList.remove('mhz-td-col-resizing');
      target.style.cursor = '';

      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);

      const updatedHtml = (table.parentElement?.innerHTML || table.outerHTML);
      const current = blocksRef.current;
      const idx = current.findIndex(b => b.id === blockId);
      if (idx !== -1 && updatedHtml) {
        const next = [...current];
        next[idx] = { ...next[idx], html: updatedHtml };
        onUpdateBlocks(next);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [onUpdateBlocks]);

  // Handle right-click context menu on selected text, table cells, or multiple blocks
  const handleBlockContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>, blockId: string) => {
    // 1. Check if right-clicking inside a table cell
    const currentBlocks = blocksRef.current;
    const targetBlock = currentBlocks.find(b => b.id === blockId);
    const cell = (e.target as HTMLElement).closest('td, th') as HTMLTableCellElement | null;
    const table = (e.target as HTMLElement).closest('table');

    if (targetBlock && targetBlock.type === 'table' && cell && table) {
      e.preventDefault();
      e.stopPropagation();
      const tr = cell.closest('tr');
      const allRows = Array.from(table.querySelectorAll('tr'));
      const rowIndex = tr ? allRows.indexOf(tr) : 0;
      const cellIndex = cell.cellIndex;

      // Detect multi-cell selection if user dragged/selected across multiple cells
      let targetCells: HTMLTableCellElement[] = [cell];
      const sel = window.getSelection();
      const currentRange = (sel && sel.rangeCount > 0 && !sel.isCollapsed)
        ? sel.getRangeAt(0)
        : (savedSelectionRef.current?.blockId === blockId ? savedSelectionRef.current.range : null);

      if (currentRange && table.contains(currentRange.commonAncestorContainer)) {
        const allCells = Array.from(table.querySelectorAll('th, td')) as HTMLTableCellElement[];
        const intersecting = allCells.filter(c => {
          try {
            return currentRange.intersectsNode(c);
          } catch {
            return false;
          }
        });
        if (intersecting.length > 1) {
          targetCells = intersecting;
        }
      }

      const rowIndices = Array.from(new Set(targetCells.map(c => {
        const r = c.closest('tr');
        return r ? allRows.indexOf(r) : -1;
      }))).filter(r => r !== -1).sort((a, b) => a - b);

      const colIndices = Array.from(new Set(targetCells.map(c => c.cellIndex))).sort((a, b) => a - b);

      const menuWidth = 220;
      const menuHeight = 320;
      const x = Math.min(e.clientX, window.innerWidth - menuWidth - 10);
      const y = Math.min(e.clientY, window.innerHeight - menuHeight - 10);

      setContextMenuState(null);
      setGripMenuState(null);
      setTableMenuState({
        x,
        y,
        blockId,
        rowIndex,
        colIndex: cellIndex,
        rowIndices: rowIndices.length > 0 ? rowIndices : [rowIndex],
        colIndices: colIndices.length > 0 ? colIndices : [cellIndex]
      });
      return;
    }

    // 2. Normal text selection or multi-block context menu
    const sel = window.getSelection();
    let text = sel ? sel.toString().trim() : '';
    if (!text && savedSelectionRef.current && savedSelectionRef.current.blockId === blockId) {
      text = savedSelectionRef.current.range.toString().trim();
    }
    if (text.length > 0 || selectedBlockIds.size > 1) {
      e.preventDefault();
      e.stopPropagation();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        savedSelectionRef.current = {
          range: sel.getRangeAt(0).cloneRange(),
          blockId
        };
      }
      const menuWidth = 260;
      const menuHeight = 220;
      const x = Math.min(e.clientX, window.innerWidth - menuWidth - 10);
      const y = Math.min(e.clientY, window.innerHeight - menuHeight - 10);
      setTableMenuState(null);
      setContextMenuState({ x, y, blockId });
    }
  }, [selectedBlockIds]);

  // Click outside to dismiss menus and image toolbar
  useEffect(() => {
    const handleDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.mhz-td-slash-menu')) {
        setSlashMenuState(null);
      }
      if (!target.closest('.mhz-td-context-menu')) {
        setContextMenuState(null);
        setGripMenuState(null);
        setTableMenuState(null);
      }
      if (
        !target.closest('.mhz-td-image-toolbar') &&
        target.tagName !== 'IMG' &&
        !target.closest('.mhz-td-crop-wrapper') &&
        !target.closest('.mhz-td-image-resize-handle') &&
        !target.closest('.mhz-td-crop-modal')
      ) {
        setSelectedImageInfo(null);
      }
    };
    document.addEventListener('mousedown', handleDocClick);
    return () => document.removeEventListener('mousedown', handleDocClick);
  }, []);

  // Image Block update helper (crop, resize, reset)
  const handleUpdateImageBlock = useCallback((
    blockId: string,
    imgEl: HTMLImageElement,
    newHashProps: { crop?: string; width?: number; clearCrop?: boolean; clearWidth?: boolean }
  ) => {
    const currentBlocks = blocksRef.current;
    const idx = currentBlocks.findIndex(b => b.id === blockId);
    if (idx === -1) return;
    const block = currentBlocks[idx];

    let originalSrc = imgEl.getAttribute('data-original-src') || imgEl.getAttribute('src') || '';
    if (originalSrc.startsWith('http://asset.localhost/') || originalSrc.startsWith('https://asset.localhost/') || originalSrc.startsWith('asset://')) {
      try {
        const u = new URL(originalSrc);
        let p = decodeURIComponent(u.pathname);
        if (/^\/[a-zA-Z]:/.test(p)) p = p.substring(1);
        originalSrc = p + (u.hash || '');
      } catch {}
    }

    const [cleanPath, existingHash] = originalSrc.split('#');
    const hashParams = new URLSearchParams(existingHash || '');

    if (newHashProps.clearCrop) {
      hashParams.delete('crop');
    } else if (newHashProps.crop !== undefined) {
      hashParams.set('crop', newHashProps.crop);
    }

    if (newHashProps.clearWidth) {
      hashParams.delete('width');
    } else if (newHashProps.width !== undefined) {
      hashParams.set('width', String(Math.round(newHashProps.width)));
    }

    // Decode URI component so commas in crop=x,y,w,h aren't converted to %2C
    const rawHashString = hashParams.toString();
    const newHash = rawHashString ? `#${decodeURIComponent(rawHashString)}` : '';

    let finalPath = cleanPath;
    if (baseDir && (cleanPath.includes(':') || cleanPath.startsWith('/') || cleanPath.startsWith('\\'))) {
      const normPath = cleanPath.replace(/\\/g, '/');
      const normBase = baseDir.replace(/\\/g, '/');
      if (normPath.toLowerCase().startsWith(normBase.toLowerCase())) {
        let rel = normPath.substring(normBase.length).replace(/^\/+/, '');
        finalPath = `./${rel}`;
      }
    }

    const finalSrcWithHash = `${finalPath}${newHash}`;
    const alt = imgEl.getAttribute('alt') || '';
    const title = imgEl.getAttribute('title') || '';

    const newHtml = renderImageHtml(finalSrcWithHash, alt, title, baseDir);

    const newBlocks = [...currentBlocks];
    newBlocks[idx] = {
      ...block,
      html: newHtml,
      isRaw: false
    };

    onUpdateBlocks(newBlocks);

    // Keep selectedImageInfo bound to the new image element after DOM update
    setTimeout(() => {
      const blockEl = document.getElementById(`edit-${blockId}`);
      const newImg = blockEl?.querySelector('img') as HTMLImageElement | null;
      if (newImg) {
        setSelectedImageInfo({
          blockId,
          target: newImg,
          src: newImg.src,
          originalSrc: newImg.getAttribute('data-original-src') || newImg.src
        });
      }
    }, 40);
  }, [baseDir, onUpdateBlocks]);

  const handleSetImageWidthPercent = useCallback((blockId: string, imgEl: HTMLImageElement, percent: number) => {
    const cropWrapper = imgEl.closest('span[data-crop-rect]') as HTMLElement | null;
    let baseWidth = imgEl.naturalWidth || 600;
    if (cropWrapper) {
      const cropRect = cropWrapper.getAttribute('data-crop-rect')?.split(',').map(Number);
      if (cropRect && cropRect[2] > 0) {
        baseWidth = cropRect[2];
      }
    }
    const targetWidth = Math.round(baseWidth * percent);
    handleUpdateImageBlock(blockId, imgEl, { width: targetWidth });
  }, [handleUpdateImageBlock]);

  const handleResetImage = useCallback((blockId: string, imgEl: HTMLImageElement) => {
    handleUpdateImageBlock(blockId, imgEl, { clearCrop: true, clearWidth: true });
  }, [handleUpdateImageBlock]);

  const handleOpenImageFolder = useCallback(async (originalSrc: string) => {
    let cleanSrc = originalSrc.split('#')[0].split('?')[0];
    if (cleanSrc.startsWith('http://asset.localhost') || cleanSrc.startsWith('https://asset.localhost') || cleanSrc.startsWith('asset://')) {
      try {
        const u = new URL(cleanSrc);
        let p = decodeURIComponent(u.pathname);
        p = p.replace(/^\/+([a-zA-Z]:)/, '$1');
        cleanSrc = p;
      } catch {}
    }
    cleanSrc = cleanSrc.replace(/^[/\\]*\?+[/\\]+/, '').replace(/^\\\\\?\\/, '');
    if (/^\/[a-zA-Z]:/.test(cleanSrc)) {
      cleanSrc = cleanSrc.substring(1);
    }

    let absPath = cleanSrc;
    const isAbs = /^[a-zA-Z]:[/\\]/.test(cleanSrc) || cleanSrc.startsWith('\\\\');
    if (!isAbs && baseDir) {
      const cleanRel = cleanSrc.replace(/^\.[/\\]/, '');
      const cleanBase = baseDir.replace(/[/\\]+$/, '');
      absPath = `${cleanBase}/${cleanRel}`;
    }
    absPath = absPath.replace(/\//g, '\\');

    try {
      await invoke('open_in_explorer', { path: absPath });
    } catch (err) {
      console.error('Failed to open image in explorer:', err);
    }
  }, [baseDir]);

  // Window listeners for corner dragging to resize image
  useEffect(() => {
    if (!isResizingImage) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeDragRef.current) return;
      const { startX, startWidth, imgEl, zoom } = resizeDragRef.current;
      const deltaX = (e.clientX - startX) / (zoom || 1);
      const newWidth = Math.max(50, Math.round(startWidth + deltaX));

      const cropWrapper = imgEl.closest('span[data-crop-rect]') as HTMLElement | null;
      if (cropWrapper) {
        const cropRect = cropWrapper.getAttribute('data-crop-rect')?.split(',').map(Number);
        if (cropRect && cropRect.length === 4) {
          const [, , cw] = cropRect;
          const scale = newWidth / cw;
          (cropWrapper.style as any).zoom = `${scale}`;
          cropWrapper.setAttribute('data-custom-width', `${newWidth}`);
        }
      } else {
        imgEl.style.width = `${newWidth}px`;
        imgEl.setAttribute('data-custom-width', `${newWidth}`);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (resizeDragRef.current) {
        const { startX, startWidth, blockId, imgEl, zoom } = resizeDragRef.current;
        const deltaX = (e.clientX - startX) / (zoom || 1);
        const newWidth = Math.max(50, Math.round(startWidth + deltaX));
        handleUpdateImageBlock(blockId, imgEl, { width: newWidth });
      }
      setIsResizingImage(false);
      resizeDragRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingImage, handleUpdateImageBlock]);

  // Visual outline on selected image
  useEffect(() => {
    document.querySelectorAll('.selected-image-outline').forEach(el => {
      el.classList.remove('selected-image-outline');
    });
    if (selectedImageInfo?.target) {
      const wrapper = selectedImageInfo.target.closest('span[data-crop-rect]') || selectedImageInfo.target;
      wrapper.classList.add('selected-image-outline');
    }
  }, [selectedImageInfo]);

  // Keyboard listener when image is selected (F2 to raw, Esc to deselect)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2' && selectedImageInfo) {
        e.preventDefault();
        e.stopPropagation();
        handleToggleRawMarkdown(selectedImageInfo.blockId);
        setSelectedImageInfo(null);
      } else if (e.key === 'Escape' && selectedImageInfo) {
        setSelectedImageInfo(null);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [selectedImageInfo]);

  // Real-time synchronization of floating toolbar position while image is selected
  // Handles document zoom (Ctrl+Wheel / Ctrl+-/+), scrolling, resizing, and layout changes
  const [, setFloatingPosTick] = useState(0);
  useEffect(() => {
    if (!selectedImageInfo) return;
    let rafId: number;
    let isMounted = true;

    const tick = () => {
      if (!isMounted) return;
      if (!document.body.contains(selectedImageInfo.target)) {
        setSelectedImageInfo(null);
        return;
      }
      setFloatingPosTick(t => (t + 1) % 100000);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      isMounted = false;
      cancelAnimationFrame(rafId);
    };
  }, [selectedImageInfo]);

  // Execute a slash command to convert block type
  const executeSlashCommand = useCallback((cmd: SlashCommand, blockId: string) => {
    const currentBlocks = blocksRef.current;
    const idx = currentBlocks.findIndex(b => b.id === blockId);
    if (idx === -1) return;
    const block = currentBlocks[idx];

    // Remove the slash and slash query text cleanly from content
    let cleanHtml = block.html
      .replace(/\/([a-zA-Z0-9_\-]*)$/g, '')
      .replace(/^\/([a-zA-Z0-9_\-]*)/g, '')
      .replace(/>\/([a-zA-Z0-9_\-]*)<\//g, '></')
      .replace(/\u200B/g, '')
      .trim();
    if (!cleanHtml && cmd.defaultHtml) {
      cleanHtml = cmd.defaultHtml;
    }

    const newBlocks = [...currentBlocks];
    newBlocks[idx] = {
      ...block,
      type: cmd.type,
      listType: cmd.listType,
      checked: cmd.type === 'checkbox' ? false : undefined,
      html: cleanHtml,
      isRaw: false
    };

    setSlashMenuState(null);
    onUpdateBlocks(newBlocks);
    focusBlock(block.id, cleanHtml.length);
  }, [onUpdateBlocks]);

  // Toggle checkbox state
  const handleToggleCheckbox = useCallback((blockId: string) => {
    const current = blocksRef.current;
    const next = current.map(b => (b.id === blockId ? { ...b, checked: !b.checked } : b));
    onUpdateBlocks(next);
  }, [onUpdateBlocks]);

  // Update block HTML from contentEditable
  const handleBlockInput = useCallback((e: React.FormEvent<HTMLDivElement>, blockId: string) => {
    const newHtml = e.currentTarget.innerHTML;
    const current = blocksRef.current;
    const next = current.map(b => (b.id === blockId ? { ...b, html: newHtml } : b));
    onUpdateBlocks(next);

    // Detect Slash ('/') command trigger at caret
    const { isSlashActive, query } = getSlashQueryAtCaret(e.currentTarget);
    if (isSlashActive) {
      setSlashMenuState(s => ({
        blockId,
        view: (s?.blockId === blockId && !query && s.view !== 'main') ? s.view : 'main',
        selectedIndex: 0,
        filterText: query
      }));
    } else if (slashMenuState && slashMenuState.blockId === blockId) {
      setSlashMenuState(null);
    }
  }, [onUpdateBlocks, slashMenuState]);

  // Select block helper (supports Shift range select and Ctrl toggle select)
  const handleSelectBlock = useCallback((blockId: string, e?: React.MouseEvent | { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => {
    const current = blocksRef.current;
    if (e?.shiftKey) {
      const anchorId = lastAnchorBlockId || focusedBlockId || current[0]?.id;
      const idx1 = current.findIndex(b => b.id === anchorId);
      const idx2 = current.findIndex(b => b.id === blockId);
      if (idx1 !== -1 && idx2 !== -1) {
        const start = Math.min(idx1, idx2);
        const end = Math.max(idx1, idx2);
        const newSet = new Set<string>();
        for (let i = start; i <= end; i++) {
          if (!hiddenBlockIds.has(current[i].id)) {
            newSet.add(current[i].id);
          }
        }
        setSelectedBlockIds(newSet);
        setFocusedBlockId(blockId);
        window.getSelection()?.removeAllRanges();
        return;
      }
    }

    if (e?.ctrlKey || e?.metaKey) {
      setSelectedBlockIds(prev => {
        const next = new Set(prev);
        if (next.has(blockId)) next.delete(blockId);
        else next.add(blockId);
        return next.size > 0 ? next : new Set([blockId]);
      });
      setLastAnchorBlockId(blockId);
      setFocusedBlockId(blockId);
      return;
    }

    setSelectedBlockIds(new Set([blockId]));
    setLastAnchorBlockId(blockId);
    setFocusedBlockId(blockId);
  }, [lastAnchorBlockId, focusedBlockId, hiddenBlockIds]);

  // Multi-block indent/outdent helper (Tab / Shift+Tab)
  const indentSelectedBlocks = useCallback((direction: 1 | -1) => {
    const current = blocksRef.current;
    const targetIds = selectedBlockIds.size > 0 ? selectedBlockIds : (focusedBlockId ? new Set([focusedBlockId]) : new Set<string>());
    if (targetIds.size === 0) return;

    const activeEl = focusedBlockId ? document.getElementById(`edit-${focusedBlockId}`) : null;
    const caretOffset = activeEl ? getCaretOffset(activeEl) : 0;

    const newBlocks = current.map(b => {
      if (targetIds.has(b.id)) {
        if (direction === 1) {
          // If no Turn into element is applied (plain paragraph) -> turn into Unordered List (ul) at CURRENT indent (no jump!)
          if (b.type === 'paragraph') {
            return {
              ...b,
              type: 'list' as BlockType,
              listType: 'ul' as const,
              indent: b.indent
            };
          }
          const nextIndent = Math.max(0, Math.min(6, b.indent + 1));
          return { ...b, indent: nextIndent };
        } else {
          // Outdent (direction === -1)
          if (b.indent <= 0) {
            // If already at root indent and is a list, convert back to plain paragraph
            if (b.type === 'list') {
              return {
                ...b,
                type: 'paragraph' as BlockType,
                listType: undefined,
                indent: 0
              };
            }
            return b;
          }
          const nextIndent = Math.max(0, b.indent - 1);
          return { ...b, indent: nextIndent };
        }
      }
      return b;
    });

    onUpdateBlocks(newBlocks);

    if (focusedBlockId) {
      setTimeout(() => {
        focusBlock(focusedBlockId, caretOffset);
      }, 0);
    }
  }, [selectedBlockIds, focusedBlockId, onUpdateBlocks]);

  // Multi-block move helper (Ctrl+ArrowUp / Ctrl+ArrowDown)
  const moveSelectedBlocks = useCallback((direction: 'up' | 'down') => {
    const current = [...blocksRef.current];
    const targetIds = selectedBlockIds.size > 0 ? selectedBlockIds : (focusedBlockId ? new Set([focusedBlockId]) : new Set<string>());
    if (targetIds.size === 0) return;

    const indices = current
      .map((b, idx) => (targetIds.has(b.id) ? idx : -1))
      .filter(idx => idx !== -1);

    if (indices.length === 0) return;

    if (direction === 'up') {
      if (indices[0] === 0) return;
      for (const idx of indices) {
        const temp = current[idx];
        current[idx] = current[idx - 1];
        current[idx - 1] = temp;
      }
    } else {
      if (indices[indices.length - 1] === current.length - 1) return;
      for (let i = indices.length - 1; i >= 0; i--) {
        const idx = indices[i];
        const temp = current[idx];
        current[idx] = current[idx + 1];
        current[idx + 1] = temp;
      }
    }

    onUpdateBlocks(current);
  }, [selectedBlockIds, focusedBlockId, onUpdateBlocks]);

  // Multi-block delete helper (Delete / Backspace key or Grip context menu)
  const deleteSelectedBlocks = useCallback(() => {
    const current = blocksRef.current;
    const targetIds = selectedBlockIds.size > 0 ? selectedBlockIds : (focusedBlockId ? new Set([focusedBlockId]) : new Set<string>());
    if (targetIds.size === 0) return;

    const remaining = current.filter(b => !targetIds.has(b.id));
    if (remaining.length === 0) {
      const freshId = generateId();
      onUpdateBlocks([{ id: freshId, type: 'paragraph', html: '', indent: 0 }]);
      setSelectedBlockIds(new Set([freshId]));
      setLastAnchorBlockId(freshId);
      focusBlock(freshId, 0);
      return;
    }

    const firstSelectedIdx = current.findIndex(b => targetIds.has(b.id));
    const nextFocusIdx = Math.min(Math.max(0, firstSelectedIdx), remaining.length - 1);
    const nextFocusBlock = remaining[nextFocusIdx];

    onUpdateBlocks(remaining);
    setSelectedBlockIds(new Set([nextFocusBlock.id]));
    setLastAnchorBlockId(nextFocusBlock.id);
    focusBlock(nextFocusBlock.id, 0);
  }, [selectedBlockIds, focusedBlockId, onUpdateBlocks]);

  // Set horizontal alignment on blocks (left / center / right)
  const setBlocksAlign = useCallback((align: 'left' | 'center' | 'right', targetBlockId?: string) => {
    const current = blocksRef.current;
    const targetIds = selectedBlockIds.size > 0
      ? selectedBlockIds
      : new Set([targetBlockId || focusedBlockId || '']);

    const next = current.map(b => {
      if (targetIds.has(b.id)) {
        return { ...b, align };
      }
      return b;
    });

    onUpdateBlocks(next);
    setGripMenuState(null);
    setContextMenuState(null);
  }, [selectedBlockIds, focusedBlockId, onUpdateBlocks]);

  // Handle Key Down events (Enter, Backspace, Space triggers, Tab, F2, ESC, ArrowUp/Down, Slash menu)
  const handleBlockKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>, blockId: string) => {
    if (e.nativeEvent.isComposing) return;

    const currentBlocks = blocksRef.current;
    const index = currentBlocks.findIndex(b => b.id === blockId);
    if (index === -1) return;
    const block = currentBlocks[index];

    // If Slash Menu is open, handle navigation, sub-views & selection
    if (slashMenuState && slashMenuState.blockId === blockId) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (slashMenuState.view !== 'main') {
          setSlashMenuState(s => s ? { ...s, view: 'main', selectedIndex: 0 } : null);
        } else {
          setSlashMenuState(null);
        }
        return;
      }

      // --- Subview: Colors (Navigate swatches with Arrows, Enter to apply, 1~6/Shift+1~6 direct shortcuts) ---
      if (slashMenuState.view === 'colors') {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          e.stopPropagation();
          setColorNav(c => ({ ...c, col: 'text' }));
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          setColorNav(c => ({ ...c, col: 'bg' }));
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setColorNav(c => ({ ...c, row: (c.row + 1) % 6 }));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setColorNav(c => ({ ...c, row: (c.row - 1 + 6) % 6 }));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const chosenColor = colorNav.col === 'text' ? TEXT_COLORS_DARK[colorNav.row] : BG_COLORS_DARK[colorNav.row];
          applyColor(colorNav.col, chosenColor, blockId);
          return;
        }
        const num = parseInt(e.key);
        if (!isNaN(num) && num >= 1 && num <= 6 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            applyColor('bg', BG_COLORS_DARK[num - 1], blockId);
          } else {
            applyColor('text', TEXT_COLORS_DARK[num - 1], blockId);
          }
          return;
        }
        return;
      }

      // --- Subview: Turn into (Compact list navigation with Arrows, Enter, or 1/2/3/P/Q/L/V/K/D/M) ---
      if (slashMenuState.view === 'turnInto' && !slashMenuState.filterText) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setSlashMenuState(s => s ? { ...s, selectedIndex: (s.selectedIndex + 1) % TURN_INTO_ITEMS.length } : null);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setSlashMenuState(s => s ? { ...s, selectedIndex: (s.selectedIndex - 1 + TURN_INTO_ITEMS.length) % TURN_INTO_ITEMS.length } : null);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const selectedCmd = TURN_INTO_ITEMS[Math.min(slashMenuState.selectedIndex, TURN_INTO_ITEMS.length - 1)];
          if (selectedCmd.type === 'table') insertTable(blockId);
          else executeSlashCommand(selectedCmd, blockId);
          return;
        }
        // Direct single key shortcuts inside Turn Into (1~6 for H1~H6, P for Paragraph, etc.)
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const matched = TURN_INTO_ITEMS.find(c => c.shortcut.toLowerCase() === e.key.toLowerCase());
          if (matched) {
            e.preventDefault();
            e.stopPropagation();
            if (matched.type === 'table') insertTable(blockId);
            else executeSlashCommand(matched, blockId);
            return;
          }
        }
        return;
      }

      // --- Subview: Main View (Navigate Turn Into, Colors, Quick Blocks with Arrows, Enter, or T / C shortcuts) ---
      if (slashMenuState.view === 'main' && !slashMenuState.filterText) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setSlashMenuState(s => s ? { ...s, selectedIndex: (s.selectedIndex + 1) % MAIN_MENU_ITEMS.length } : null);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setSlashMenuState(s => s ? { ...s, selectedIndex: (s.selectedIndex - 1 + MAIN_MENU_ITEMS.length) % MAIN_MENU_ITEMS.length } : null);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const item = MAIN_MENU_ITEMS[Math.min(slashMenuState.selectedIndex, MAIN_MENU_ITEMS.length - 1)];
          if (item.isTurnInto) {
            setSlashMenuState(s => s ? { ...s, view: 'turnInto', selectedIndex: 0 } : null);
          } else if (item.isColors) {
            setSlashMenuState(s => s ? { ...s, view: 'colors' } : null);
            setColorNav({ col: 'text', row: 0 });
          } else if (item.isTable) {
            insertTable(blockId);
          } else if (item.cmdId) {
            const cmd = SLASH_COMMANDS.find(c => c.id === item.cmdId);
            if (cmd) executeSlashCommand(cmd, blockId);
          }
          return;
        }
        // Direct T key opens Turn into
        if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          setSlashMenuState(s => s ? { ...s, view: 'turnInto', selectedIndex: 0 } : null);
          return;
        }
        // Direct C key opens Colors
        if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          setSlashMenuState(s => s ? { ...s, view: 'colors' } : null);
          setColorNav({ col: 'text', row: 0 });
          return;
        }
        // Other quick shortcuts (1, 2, L, V, K, D, M)
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const matched = MAIN_MENU_ITEMS.find(m => m.shortcut.toLowerCase() === e.key.toLowerCase());
          if (matched) {
            e.preventDefault();
            e.stopPropagation();
            if (matched.isTable) insertTable(blockId);
            else if (matched.cmdId) {
              const cmd = SLASH_COMMANDS.find(c => c.id === matched.cmdId);
              if (cmd) executeSlashCommand(cmd, blockId);
            }
            return;
          }
        }
        return;
      }

      // --- Filtered Search Results (when typing after '/') ---
      if (slashMenuState.filterText) {
        const filtered = getFilteredSlashCommands(slashMenuState.filterText);
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          if (filtered.length > 0) {
            setSlashMenuState(s => s ? { ...s, selectedIndex: (s.selectedIndex + 1) % filtered.length } : null);
          }
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          if (filtered.length > 0) {
            setSlashMenuState(s => s ? { ...s, selectedIndex: (s.selectedIndex - 1 + filtered.length) % filtered.length } : null);
          }
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          if (filtered.length > 0) {
            const selectedCmd = filtered[Math.min(slashMenuState.selectedIndex, filtered.length - 1)];
            if (selectedCmd.type === 'table') insertTable(blockId);
            else executeSlashCommand(selectedCmd, blockId);
          }
          return;
        }
      }
    }

    // Direct trigger for Slash menu if user types '/'
    if (e.key === '/') {
      setTimeout(() => {
        const el = document.getElementById(`edit-${blockId}`);
        if (!el) return;
        const { isSlashActive, query } = getSlashQueryAtCaret(el);
        if (isSlashActive) {
          setSlashMenuState(s => ({
            blockId,
            view: (s?.blockId === blockId && !query && s.view !== 'main') ? s.view : 'main',
            selectedIndex: 0,
            filterText: query
          }));
        }
      }, 0);
    }

    // ESC Key: Exit F2 raw editing mode and apply/render the edited markdown content
    if (e.key === 'Escape' && block.isRaw) {
      e.preventDefault();
      e.stopPropagation();

      const currentHtml = (e.currentTarget as HTMLElement)?.innerHTML || block.html || '';
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = currentHtml;
      tempDiv.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
      tempDiv.querySelectorAll('div, p').forEach(el => el.before('\n'));
      let rawMd = (tempDiv.textContent || tempDiv.innerText || '').trim();
      rawMd = rawMd.replace(/\u00A0/g, ' ');

      const converted = fromRawMarkdown(rawMd, block, baseDir);
      const newBlocks = [...currentBlocks];
      newBlocks[index] = {
        ...block,
        ...converted,
        isRaw: false
      };

      onUpdateBlocks(newBlocks);
      focusBlock(block.id, 0);
      return;
    }

    // F2 Key: Toggle between Rendered mode and Raw Markdown editing for this block
    if (e.key === 'F2') {
      e.preventDefault();
      e.stopPropagation();

      const newBlocks = [...currentBlocks];
      if (block.isRaw) {
        // Toggle back from raw markdown to rendered HTML
        const currentHtml = (e.currentTarget as HTMLElement)?.innerHTML || block.html || '';
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = currentHtml;
        tempDiv.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        tempDiv.querySelectorAll('div, p').forEach(el => el.before('\n'));
        let rawMd = (tempDiv.textContent || tempDiv.innerText || '').trim();
        rawMd = rawMd.replace(/\u00A0/g, ' ');

        const converted = fromRawMarkdown(rawMd, block, baseDir);
        newBlocks[index] = {
          ...block,
          ...converted,
          isRaw: false
        };
      } else {
        // Toggle to raw markdown text
        const rawMd = toRawMarkdown(block, baseDir);
        newBlocks[index] = { ...block, html: rawMd, isRaw: true };
      }

      onUpdateBlocks(newBlocks);
      focusBlock(block.id, 0);
      return;
    }

    // =========================================================================
    // Table Keyboard Navigation & Cell Management
    // (ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Enter, Shift+Enter, Tab, Shift+Tab)
    // =========================================================================
    if (block.type === 'table' && !block.isRaw) {
      const sel = window.getSelection();
      const anchorNode = sel?.anchorNode;
      const cell = (anchorNode instanceof HTMLElement ? anchorNode : anchorNode?.parentElement)?.closest('td, th') as HTMLTableCellElement | null;
      const table = cell?.closest('table') as HTMLTableElement | null;

      if (cell && table) {
        const tr = cell.closest('tr');
        const allRows = Array.from(table.querySelectorAll('tr'));
        const currRowIndex = tr ? allRows.indexOf(tr) : -1;
        const colIndex = cell.cellIndex;
        const allCells = Array.from(table.querySelectorAll('th, td')) as HTMLTableCellElement[];
        const cellIndex = allCells.indexOf(cell);

        // 1. Alt+Enter or Ctrl+Enter: Insert line break (<br>) within table cell!
        if (e.key === 'Enter' && (e.altKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();

          try {
            document.execCommand('insertHTML', false, '<br>');
          } catch {
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0) {
              const range = selection.getRangeAt(0);
              range.deleteContents();
              const br = document.createElement('br');
              range.insertNode(br);
              const zwsp = document.createTextNode('\u200B');
              range.setStartAfter(br);
              range.insertNode(zwsp);
              range.setStartAfter(zwsp);
              range.collapse(true);
              selection.removeAllRanges();
              selection.addRange(range);
            }
          }

          const updatedHtml = (table.parentElement?.innerHTML || table.outerHTML);
          const nextBlocks = [...currentBlocks];
          nextBlocks[index] = { ...block, html: updatedHtml };
          onUpdateBlocks(nextBlocks);
          return;
        }

        // 2. Enter / Shift+Enter: Navigate vertically between rows (or append row at bottom)
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();

          if (e.shiftKey) {
            // Shift+Enter: move up to previous row in same column
            if (currRowIndex > 0) {
              const targetRow = allRows[currRowIndex - 1];
              const targetCell = targetRow.children[Math.min(colIndex, targetRow.children.length - 1)] as HTMLElement;
              if (targetCell) focusCell(targetCell, 'all');
            }
          } else {
            // Enter: move down to next row in same column (or add row at bottom)
            if (currRowIndex >= 0 && currRowIndex < allRows.length - 1) {
              const targetRow = allRows[currRowIndex + 1];
              const targetCell = targetRow.children[Math.min(colIndex, targetRow.children.length - 1)] as HTMLElement;
              if (targetCell) focusCell(targetCell, 'all');
            } else {
              // At bottom row: add a new row and move to it
              const colCount = Math.max(1, allRows[0].querySelectorAll('th, td').length);
              const newTr = document.createElement('tr');
              for (let c = 0; c < colCount; c++) {
                const newTd = document.createElement('td');
                newTd.innerHTML = 'Item';
                newTr.appendChild(newTd);
              }
              const tbody = table.querySelector('tbody') || table;
              tbody.appendChild(newTr);

              const updatedHtml = (table.parentElement?.innerHTML || table.outerHTML);
              const nextBlocks = [...currentBlocks];
              nextBlocks[index] = { ...block, html: updatedHtml };
              onUpdateBlocks(nextBlocks);

              const targetCell = newTr.children[Math.min(colIndex, colCount - 1)] as HTMLElement;
              if (targetCell) {
                setTimeout(() => focusCell(targetCell, 'all'), 10);
              }
            }
          }
          return;
        }

        // 2. Tab / Shift+Tab: Navigate horizontally between cells (or append row on last cell)
        if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();

          if (!e.shiftKey) {
            // Tab: move right/next cell
            if (cellIndex < allCells.length - 1) {
              const nextCell = allCells[cellIndex + 1];
              focusCell(nextCell, 'all');
            } else {
              // Very last cell in the table!
              const allRows = Array.from(table.querySelectorAll('tr'));
              const colCount = Math.max(1, allRows[0].querySelectorAll('th, td').length);
              const newTr = document.createElement('tr');
              for (let c = 0; c < colCount; c++) {
                const newTd = document.createElement('td');
                newTd.innerHTML = 'Item';
                newTr.appendChild(newTd);
              }
              const tbody = table.querySelector('tbody') || table;
              tbody.appendChild(newTr);

              const updatedHtml = (table.parentElement?.innerHTML || table.outerHTML);
              const nextBlocks = [...currentBlocks];
              nextBlocks[index] = { ...block, html: updatedHtml };
              onUpdateBlocks(nextBlocks);

              // Move cursor to first cell (leftmost) of the new row
              const firstNewCell = newTr.children[0] as HTMLElement;
              if (firstNewCell) {
                setTimeout(() => focusCell(firstNewCell, 'all'), 10);
              }
            }
          } else {
            // Shift+Tab: move left/prev cell
            if (cellIndex > 0) {
              const prevCell = allCells[cellIndex - 1];
              focusCell(prevCell, 'all');
            }
          }
          return;
        }

        // 3. ArrowUp / ArrowDown: Move vertically between rows in the same column
        if (e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
          if (currRowIndex > 0) {
            e.preventDefault();
            e.stopPropagation();
            const targetRow = allRows[currRowIndex - 1];
            const targetCell = targetRow.children[Math.min(colIndex, targetRow.children.length - 1)] as HTMLElement;
            if (targetCell) focusCell(targetCell, 'start');
            return;
          }
          // If currRowIndex === 0, allow falling through to navigate to block above table
        }

        if (e.key === 'ArrowDown' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
          if (currRowIndex >= 0 && currRowIndex < allRows.length - 1) {
            e.preventDefault();
            e.stopPropagation();
            const targetRow = allRows[currRowIndex + 1];
            const targetCell = targetRow.children[Math.min(colIndex, targetRow.children.length - 1)] as HTMLElement;
            if (targetCell) focusCell(targetCell, 'start');
            return;
          }
          // If at bottom row, allow falling through to navigate to block below table
        }

        // 4. ArrowRight: Move within cell, and jump to start of next cell when at end of cell text
        if (e.key === 'ArrowRight' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
          const caretInfo = getCellCaretInfo(cell);
          if (!caretInfo.hasSelection && caretInfo.isAtEnd) {
            if (cellIndex < allCells.length - 1) {
              e.preventDefault();
              e.stopPropagation();
              const nextCell = allCells[cellIndex + 1];
              focusCell(nextCell, 'start');
              return;
            }
          }
          // Inside cell: browser natively navigates within cell text
        }

        // 5. ArrowLeft: Move within cell, and jump to end of previous cell when at start of cell text
        if (e.key === 'ArrowLeft' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
          const caretInfo = getCellCaretInfo(cell);
          if (!caretInfo.hasSelection && caretInfo.isAtStart) {
            if (cellIndex > 0) {
              e.preventDefault();
              e.stopPropagation();
              const prevCell = allCells[cellIndex - 1];
              focusCell(prevCell, 'end');
              return;
            }
          }
          // Inside cell: browser natively navigates within cell text
        }
      }
    }

    // Enter Key: Split block, create next item, or divider trigger
    if (e.key === 'Enter' && !e.shiftKey) {
      if (block.type === 'table') {
        return; // Prevent table block from splitting and creating empty block
      }
      e.preventDefault();
      e.stopPropagation();

      const text = (e.currentTarget.innerText || '').trim();

      // If user typed '---' or '***' or '___' and pressed Enter:
      if (/^(\*{3,}|-{3,}|_{3,})$/.test(text)) {
        const newBlock: Block = {
          id: generateId(),
          type: 'paragraph',
          html: '',
          indent: 0,
          isRaw: false
        };
        const newBlocks = [...currentBlocks];
        newBlocks[index] = { ...block, type: 'divider', html: '', isRaw: false };
        newBlocks.splice(index + 1, 0, newBlock);
        onUpdateBlocks(newBlocks);
        focusBlock(newBlock.id, 0);
        return;
      }

      // If on a rendered divider block:
      if (block.type === 'divider') {
        const newBlock: Block = {
          id: generateId(),
          type: 'paragraph',
          html: '',
          indent: 0,
          isRaw: false
        };
        const newBlocks = [...currentBlocks];
        newBlocks.splice(index + 1, 0, newBlock);
        onUpdateBlocks(newBlocks);
        focusBlock(newBlock.id, 0);
        return;
      }

      // Split content based on caret position
      const selection = window.getSelection();
      let contentBefore = block.html;
      let contentAfter = '';

      if (selection && selection.rangeCount > 0) {
        try {
          const range = selection.getRangeAt(0);
          if (e.currentTarget.contains(range.startContainer)) {
            const rangeAfter = range.cloneRange();
            rangeAfter.selectNodeContents(e.currentTarget);
            rangeAfter.setStart(range.endContainer, range.endOffset);
            const fragmentAfter = rangeAfter.cloneContents();
            const divAfter = document.createElement('div');
            divAfter.appendChild(fragmentAfter);
            contentAfter = divAfter.innerHTML;

            const rangeBefore = range.cloneRange();
            rangeBefore.selectNodeContents(e.currentTarget);
            rangeBefore.setEnd(range.startContainer, range.startOffset);
            const fragmentBefore = rangeBefore.cloneContents();
            const divBefore = document.createElement('div');
            divBefore.appendChild(fragmentBefore);
            contentBefore = divBefore.innerHTML;
          }
        } catch {}
      }

      const isHeader = /^h[1-6]$/.test(block.type);
      const nextType: BlockType = isHeader ? 'paragraph' : block.type;

      const newBlock: Block = {
        id: generateId(),
        type: nextType,
        html: contentAfter,
        indent: block.indent,
        listType: block.type === 'list' ? block.listType : undefined,
        checked: block.type === 'checkbox' ? false : undefined,
        isRaw: false
      };

      const newBlocks = [...currentBlocks];
      newBlocks[index] = { ...block, html: contentBefore };
      newBlocks.splice(index + 1, 0, newBlock);

      // If the current block or its parent heading was folded, unfold it so the newly created block is visible
      setCollapsedHeadingIds(prev => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        let changed = false;
        if (next.has(block.id)) {
          next.delete(block.id);
          changed = true;
        }
        for (let i = index; i >= 0; i--) {
          const b = currentBlocks[i];
          if (/^h[1-6]$/.test(b.type) && next.has(b.id)) {
            next.delete(b.id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      onUpdateBlocks(newBlocks);
      focusBlock(newBlock.id, 0);
      return;
    }

    // Backspace Key: Merge blocks, delete empty block, or un-indent
    if (e.key === 'Backspace') {
      if (block.type === 'divider') {
        e.preventDefault();
        const prevId = currentBlocks[Math.max(0, index - 1)].id;
        const newBlocks = currentBlocks.filter(b => b.id !== block.id);
        onUpdateBlocks(newBlocks);
        focusBlock(prevId, -1);
        return;
      }

      const text = e.currentTarget.innerText || '';
      const isEmpty = text.trim() === '';
      const caretOffset = getCaretOffset(e.currentTarget);

      // If at start of a list or checkbox, convert back to paragraph
      if ((block.type === 'list' || block.type === 'checkbox' || block.type === 'quote') && (isEmpty || caretOffset === 0)) {
        e.preventDefault();
        const newBlocks = [...currentBlocks];
        newBlocks[index] = { ...block, type: 'paragraph', listType: undefined, checked: undefined };
        onUpdateBlocks(newBlocks);
        return;
      }

      // If block is completely empty and there are multiple blocks, delete it
      if (isEmpty && currentBlocks.length > 1) {
        e.preventDefault();
        const prevId = currentBlocks[Math.max(0, index - 1)].id;
        const newBlocks = currentBlocks.filter(b => b.id !== block.id);
        onUpdateBlocks(newBlocks);
        focusBlock(prevId, -1);
        return;
      }

      // If caret is at start (offset 0) and previous block exists, merge into previous block
      if (caretOffset === 0 && index > 0) {
        e.preventDefault();
        const prevBlock = currentBlocks[index - 1];
        const prevEl = document.getElementById(`edit-${prevBlock.id}`);
        const prevLen = prevEl?.innerText.length || 0;

        const mergedHtml = prevBlock.html + block.html;
        const newBlocks = [...currentBlocks];
        newBlocks[index - 1] = { ...prevBlock, html: mergedHtml };
        newBlocks.splice(index, 1);

        onUpdateBlocks(newBlocks);
        focusBlock(prevBlock.id, prevLen);
        return;
      }
    }

    // Space Key: Markdown triggers (`- `, `# `, `1. `, `> `, `[] `, `--- `)
    if (e.key === ' ') {
      const text = (e.currentTarget.innerText || '').trim();
      if (/^(\*{3,}|-{3,}|_{3,})$/.test(text)) {
        e.preventDefault();
        const newBlocks = [...currentBlocks];
        newBlocks[index] = {
          ...block,
          type: 'divider',
          html: '',
          isRaw: false
        };
        onUpdateBlocks(newBlocks);
        return;
      }

      const triggers: Record<string, BlockType> = {
        '#': 'h1',
        '##': 'h2',
        '###': 'h3',
        '####': 'h4',
        '#####': 'h5',
        '######': 'h6',
        '>': 'quote',
        '-': 'list',
        '*': 'list',
        '+': 'list',
        '[]': 'checkbox',
        '[ ]': 'checkbox'
      };

      if (block.type === 'paragraph') {
        if (text === '1.') {
          e.preventDefault();
          const newBlocks = [...currentBlocks];
          newBlocks[index] = { ...block, type: 'list', listType: 'ol', html: '' };
          onUpdateBlocks(newBlocks);
          return;
        }

        if (triggers[text]) {
          e.preventDefault();
          const targetType = triggers[text];
          const newBlocks = [...currentBlocks];
          newBlocks[index] = {
            ...block,
            type: targetType,
            listType: targetType === 'list' ? 'ul' : undefined,
            checked: targetType === 'checkbox' ? false : undefined,
            html: ''
          };
          onUpdateBlocks(newBlocks);
          return;
        }
      }
    }

    // Tab Key: Block Indent / Outdent
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();

      const direction = e.shiftKey ? -1 : 1;
      indentSelectedBlocks(direction);
      return;
    }

    // Ctrl + ArrowUp / ArrowDown: Move selected blocks up or down
    if (e.ctrlKey && e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      moveSelectedBlocks('up');
      return;
    }
    if (e.ctrlKey && e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      moveSelectedBlocks('down');
      return;
    }

    // Delete or Backspace key on multiple selected blocks
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedBlockIds.size > 1) {
      e.preventDefault();
      e.stopPropagation();
      deleteSelectedBlocks();
      return;
    }

    // Alt + ArrowLeft / ArrowRight: Fold / Unfold H1, H2, H3 (Single press: current section, Double press: entire band)
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const isHeading = block.type === 'h1' || block.type === 'h2' || block.type === 'h3';
      if (isHeading) {
        e.preventDefault();
        e.stopPropagation();

        const now = Date.now();
        const isFold = e.key === 'ArrowLeft';
        const isDouble =
          lastAltArrowRef.current &&
          lastAltArrowRef.current.key === e.key &&
          lastAltArrowRef.current.type === block.type &&
          now - lastAltArrowRef.current.time < 500;

        if (isDouble) {
          // Fold / Unfold ALL headings of the same level/band (all H1, all H2, or all H3)
          const sameBand = currentBlocks.filter(b => b.type === block.type);
          setCollapsedHeadingIds(prev => {
            const next = new Set(prev);
            for (const hb of sameBand) {
              if (isFold) next.add(hb.id);
              else next.delete(hb.id);
            }
            return next;
          });
          lastAltArrowRef.current = null;
        } else {
          // Fold / Unfold current heading section
          setCollapsedHeadingIds(prev => {
            const next = new Set(prev);
            if (isFold) next.add(block.id);
            else next.delete(block.id);
            return next;
          });
          lastAltArrowRef.current = {
            key: e.key as 'ArrowLeft' | 'ArrowRight',
            time: now,
            type: block.type,
            blockId: block.id
          };
        }
        return;
      }
    }

    // Shift + ArrowUp / ArrowDown: Expand / contract block range selection
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      const anchorId = lastAnchorBlockId || block.id;
      const anchorIdx = currentBlocks.findIndex(b => b.id === anchorId);

      let targetIdx = index;
      if (e.key === 'ArrowUp') {
        let prev = index - 1;
        while (prev >= 0 && hiddenBlockIds.has(currentBlocks[prev].id)) prev--;
        if (prev >= 0) targetIdx = prev;
      } else {
        let next = index + 1;
        while (next < currentBlocks.length && hiddenBlockIds.has(currentBlocks[next].id)) next++;
        if (next < currentBlocks.length) targetIdx = next;
      }

      if (anchorIdx !== -1 && targetIdx !== -1) {
        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        const newSet = new Set<string>();
        for (let i = start; i <= end; i++) {
          if (!hiddenBlockIds.has(currentBlocks[i].id)) {
            newSet.add(currentBlocks[i].id);
          }
        }
        setSelectedBlockIds(newSet);
        setFocusedBlockId(currentBlocks[targetIdx].id);
        window.getSelection()?.removeAllRanges();

        isShiftSelectingRef.current = true;
        const targetEl = document.getElementById(`edit-${currentBlocks[targetIdx].id}`);
        if (targetEl) {
          targetEl.focus({ preventScroll: false });
        }
        setTimeout(() => {
          isShiftSelectingRef.current = false;
        }, 80);
      }
      return;
    }

    // Double Ctrl+A: Select all blocks
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      const now = Date.now();
      if (lastCtrlATimeRef.current && now - lastCtrlATimeRef.current < 450) {
        e.preventDefault();
        e.stopPropagation();
        setSelectedBlockIds(new Set(currentBlocks.map(b => b.id)));
        lastCtrlATimeRef.current = 0;
        return;
      }
      lastCtrlATimeRef.current = now;
    }

    // Block Horizontal Alignment Shortcuts: Ctrl+Shift+L (Left), Ctrl+Shift+E (Center), Ctrl+Shift+R (Right)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
      if (e.key === 'L' || e.key === 'l') {
        e.preventDefault();
        e.stopPropagation();
        setBlocksAlign('left', blockId);
        return;
      }
      if (e.key === 'E' || e.key === 'e') {
        e.preventDefault();
        e.stopPropagation();
        setBlocksAlign('center', blockId);
        return;
      }
      if (e.key === 'R' || e.key === 'r') {
        e.preventDefault();
        e.stopPropagation();
        setBlocksAlign('right', blockId);
        return;
      }
    }

    // Arrow Up / Down: Directly navigate between visible cells
    if (e.key === 'ArrowUp' && !e.ctrlKey && !e.shiftKey) {
      let prevIdx = index - 1;
      while (prevIdx >= 0 && hiddenBlockIds.has(currentBlocks[prevIdx].id)) {
        prevIdx--;
      }
      if (prevIdx >= 0) {
        e.preventDefault();
        const prevBlock = currentBlocks[prevIdx];
        setFocusedBlockId(prevBlock.id);
        setSelectedBlockIds(new Set([prevBlock.id]));
        setLastAnchorBlockId(prevBlock.id);
        focusBlock(prevBlock.id, 0);
        return;
      }
    }
    if (e.key === 'ArrowDown' && !e.ctrlKey && !e.shiftKey) {
      let nextIdx = index + 1;
      while (nextIdx < currentBlocks.length && hiddenBlockIds.has(currentBlocks[nextIdx].id)) {
        nextIdx++;
      }
      if (nextIdx < currentBlocks.length) {
        e.preventDefault();
        const nextBlock = currentBlocks[nextIdx];
        setFocusedBlockId(nextBlock.id);
        setSelectedBlockIds(new Set([nextBlock.id]));
        setLastAnchorBlockId(nextBlock.id);
        focusBlock(nextBlock.id, 0);
        return;
      }
    }
  }, [
    onUpdateBlocks,
    slashMenuState,
    colorNav,
    applyColor,
    executeSlashCommand,
    insertTable,
    selectedBlockIds,
    indentSelectedBlocks,
    moveSelectedBlocks,
    deleteSelectedBlocks,
    setBlocksAlign,
    lastAnchorBlockId,
    hiddenBlockIds
  ]);

  // Toggle raw markdown mode for a block (F2)
  const handleToggleRawMarkdown = useCallback((targetBlockId: string) => {
    const current = blocksRef.current;
    const idx = current.findIndex(b => b.id === targetBlockId);
    if (idx === -1) return;
    const block = current[idx];
    const newBlocks = [...current];
    if (block.isRaw) {
      const el = document.getElementById(`edit-${block.id}`);
      const currentHtml = el?.innerHTML || block.html || '';
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = currentHtml;
      tempDiv.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
      tempDiv.querySelectorAll('div, p').forEach(el => el.before('\n'));
      let rawMd = (tempDiv.textContent || tempDiv.innerText || '').trim();
      rawMd = rawMd.replace(/\u00A0/g, ' ');

      const converted = fromRawMarkdown(rawMd, block, baseDir);
      newBlocks[idx] = { ...block, ...converted, isRaw: false };
    } else {
      const rawMd = toRawMarkdown(block, baseDir);
      newBlocks[idx] = { ...block, html: rawMd, isRaw: true };
    }
    onUpdateBlocks(newBlocks);
    focusBlock(block.id, 0);
  }, [baseDir, onUpdateBlocks]);

  // Right-click context menu on Grip handle
  const handleGripContextMenu = useCallback((e: React.MouseEvent, blockId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedBlockIds(prev => {
      if (prev.has(blockId)) return prev;
      return new Set([blockId]);
    });
    setLastAnchorBlockId(blockId);
    setFocusedBlockId(blockId);
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 180);
    setGripMenuState({ x, y, blockId });
  }, []);

  // Pointer-based Drag & Drop for grip handles (Bypasses WebView2 HTML5 DnD limitations)
  const handleGripPointerDown = useCallback((e: React.PointerEvent, blockId: string) => {
    // Only handle primary (left) button
    if (e.button !== 0) return;
    e.preventDefault();

    const currentSelected = selectedBlockIds;
    const idsToDrag = (currentSelected.size > 1 && currentSelected.has(blockId))
      ? new Set(currentSelected)
      : new Set([blockId]);

    const sourceBlock = blocksRef.current.find(b => b.id === blockId);
    const snippet = (sourceBlock?.html || sourceBlock?.type || '')
      .replace(/<[^>]*>/g, '')
      .trim()
      .slice(0, 24);

    pointerDragInfoRef.current = {
      sourceBlockId: blockId,
      blockIds: idsToDrag,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
    };

    const handlePointerMove = (moveEv: PointerEvent) => {
      const info = pointerDragInfoRef.current;
      if (!info) return;

      const dist = Math.hypot(moveEv.clientX - info.startX, moveEv.clientY - info.startY);
      if (!info.started) {
        if (dist > 3) {
          info.started = true;
          document.body.classList.add('mhz-dragging-active');
          window.getSelection()?.removeAllRanges();

          if (!currentSelected.has(info.sourceBlockId)) {
            setSelectedBlockIds(new Set([info.sourceBlockId]));
            setFocusedBlockId(info.sourceBlockId);
          }
          setDraggedBlockIds(info.blockIds);
        } else {
          return;
        }
      }

      // Update ghost badge position
      setActiveDragGhost({
        x: moveEv.clientX,
        y: moveEv.clientY,
        count: info.blockIds.size,
        label: info.blockIds.size > 1 ? `Move ${info.blockIds.size} blocks` : (snippet || 'Move block'),
      });

      // Find element under cursor
      const el = document.elementFromPoint(moveEv.clientX, moveEv.clientY);
      const row = el?.closest('.mhz-td-block-row') as HTMLElement | null;

      if (row) {
        const targetId = row.getAttribute('data-block-id');
        if (targetId && !info.blockIds.has(targetId)) {
          const rect = row.getBoundingClientRect();
          const placement: 'before' | 'after' = moveEv.clientY > (rect.top + rect.height / 2) ? 'after' : 'before';
          setDropTarget(prev => {
            if (prev?.blockId === targetId && prev?.placement === placement) return prev;
            return { blockId: targetId, placement };
          });
          return;
        }
      }

      // If hovering near the bottom of wrapper below last block
      const wrapper = wrapperRef.current;
      if (wrapper) {
        const wrapperRect = wrapper.getBoundingClientRect();
        if (moveEv.clientY >= wrapperRect.bottom - 80) {
          const currentBlocks = blocksRef.current;
          if (currentBlocks.length > 0) {
            const last = currentBlocks[currentBlocks.length - 1];
            if (!info.blockIds.has(last.id)) {
              setDropTarget({ blockId: last.id, placement: 'after' });
              return;
            }
          }
        }
      }
    };

    const handlePointerUp = (upEv: PointerEvent) => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      document.body.classList.remove('mhz-dragging-active');

      const info = pointerDragInfoRef.current;
      pointerDragInfoRef.current = null;
      setActiveDragGhost(null);

      if (!info || !info.started) {
        // Was just a click!
        handleSelectBlock(blockId, upEv as unknown as React.MouseEvent);
        focusBlock(blockId);
        setDraggedBlockIds(null);
        setDropTarget(null);
        return;
      }

      // Execute drop reordering
      setDropTarget(target => {
        if (target && info.blockIds && !info.blockIds.has(target.blockId)) {
          const current = [...blocksRef.current];
          const dragged = current.filter(b => info.blockIds.has(b.id));
          const remaining = current.filter(b => !info.blockIds.has(b.id));
          const targetIdx = remaining.findIndex(b => b.id === target.blockId);

          if (targetIdx !== -1) {
            const insertIdx = target.placement === 'after' ? targetIdx + 1 : targetIdx;
            const reordered = [
              ...remaining.slice(0, insertIdx),
              ...dragged,
              ...remaining.slice(insertIdx)
            ];
            onUpdateBlocks(reordered);
            setSelectedBlockIds(new Set(info.blockIds));
            setFocusedBlockId(target.blockId);
          }
        }
        return null;
      });

      setDraggedBlockIds(null);
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  }, [selectedBlockIds, handleSelectBlock, focusBlock, onUpdateBlocks]);

  return (
    <div
      ref={wrapperRef}
      className="mhz-td-wrapper"
      style={{ fontSize: `${fontSize}px` }}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === 'ArrowUp') {
          e.preventDefault();
          moveSelectedBlocks('up');
        } else if (e.ctrlKey && e.key === 'ArrowDown') {
          e.preventDefault();
          moveSelectedBlocks('down');
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedBlockIds.size > 1) {
          e.preventDefault();
          deleteSelectedBlocks();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          indentSelectedBlocks(e.shiftKey ? -1 : 1);
        } else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
          e.preventDefault();
        } else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && selectedBlockIds.size > 1) {
          e.preventDefault();
          const selected = blocks.filter(b => selectedBlockIds.has(b.id));
          const md = serializeBlocksToMarkdown(selected);
          navigator.clipboard.writeText(md);
        }
      }}
    >
      {blocks.map((block, idx) => {
        const isHidden = hiddenBlockIds.has(block.id);
        const isHeading = block.type === 'h1' || block.type === 'h2' || block.type === 'h3';
        const isCollapsed = collapsedHeadingIds.has(block.id);
        const isFocused = focusedBlockId === block.id;
        const isSelected = selectedBlockIds.has(block.id);
        const isBeingDragged = draggedBlockIds?.has(block.id);
        const isDropTargetBefore = dropTarget?.blockId === block.id && dropTarget.placement === 'before';
        const isDropTargetAfter = dropTarget?.blockId === block.id && dropTarget.placement === 'after';

        return (
          <div
            key={block.id}
            data-block-id={block.id}
            className={`mhz-td-block-row mhz-td-row-${block.type} ${isFocused ? 'focused' : ''} ${isSelected ? 'selected' : ''} ${block.isRaw ? 'editing' : ''} ${isBeingDragged ? 'is-dragging' : ''} ${isDropTargetBefore ? 'drop-target-before' : ''} ${isDropTargetAfter ? 'drop-target-after' : ''}`}
            style={{ display: isHidden ? 'none' : undefined }}
            onMouseDown={(e) => {
              if (e.shiftKey) {
                e.preventDefault();
                handleSelectBlock(block.id, { shiftKey: true });
              }
            }}
            onClick={(e) => handleSelectBlock(block.id, e)}
          >
            {/* Left Grip Handle & Actions */}
            <div
              className="mhz-td-block-gutter"
              onContextMenu={(e) => handleGripContextMenu(e, block.id)}
            >
              {isHeading && (
                <div
                  className={`mhz-td-fold-btn ${isCollapsed ? 'collapsed' : ''}`}
                  title={isCollapsed ? "Unfold Section (Alt+→) / Unfold All (Alt+→×2)" : "Fold Section (Alt+←) / Fold All (Alt+←×2)"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleHeadingFold(block.id);
                  }}
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </div>
              )}
              <span
                className="mhz-td-line-number"
                title="Click to select block (Shift: range select, Ctrl: multi-select)"
                onClick={(e) => {
                  e.stopPropagation();
                  handleSelectBlock(block.id, e);
                }}
              >
                {idx + 1}
              </span>
              <div
                className={`mhz-td-grip ${isBeingDragged ? 'grabbing' : ''}`}
                title={selectedBlockIds.size > 1 && selectedBlockIds.has(block.id)
                  ? `Drag to move ${selectedBlockIds.size} selected blocks (Right-click: menu)`
                  : "Drag to move block (Shift/Ctrl click: multi-select, Right-click: menu)"}
                onPointerDown={(e) => handleGripPointerDown(e, block.id)}
                onContextMenu={(e) => handleGripContextMenu(e, block.id)}
              >
                <GripVertical size={13} />
              </div>
            </div>

            {/* Block Body */}
            <div
              className="mhz-td-block-body"
              style={{ paddingLeft: `${block.indent * 24}px` }}
            >
              {block.type === 'divider' && !block.isRaw ? (
                <div
                  id={`edit-${block.id}`}
                  data-block-id={block.id}
                  tabIndex={0}
                  className="mhz-td-divider"
                  onKeyDown={(e) => handleBlockKeyDown(e, block.id)}
                  onFocus={() => {
                    setFocusedBlockId(block.id);
                    handleSelectBlock(block.id);
                  }}
                  onBlur={() => setFocusedBlockId(null)}
                  onClick={(e) => {
                    setFocusedBlockId(block.id);
                    handleSelectBlock(block.id, e);
                  }}
                >
                  <hr />
                </div>
              ) : (
                <div className="mhz-td-content-container">
                  {/* List Bullet or Number (Hidden in raw markdown editing mode) */}
                  {!block.isRaw && (
                    <ListMarker
                      type={block.type}
                      listType={block.listType}
                      indent={block.indent}
                      index={idx}
                      blocks={blocks}
                    />
                  )}

                  {/* Blockquote Bar (Hidden in raw markdown editing mode) */}
                  {block.type === 'quote' && !block.isRaw && <div className="mhz-td-quote-bar" />}

                  {/* Checkbox Icon (Hidden in raw markdown editing mode) */}
                  {block.type === 'checkbox' && !block.isRaw && (
                    <div
                      className="mhz-td-checkbox-icon"
                      contentEditable={false}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleCheckbox(block.id);
                      }}
                    >
                      {block.checked ? (
                        <CheckSquare size={16} className="checked" />
                      ) : (
                        <Square size={16} />
                      )}
                    </div>
                  )}

                  {/* Table quick row/column controls */}
                  {block.type === 'table' && !block.isRaw && (
                    <div className="mhz-td-table-controls" contentEditable={false}>
                      <button
                        type="button"
                        className="mhz-td-table-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTableAction(block.id, 'add_row_bottom');
                        }}
                        title="Add row at bottom"
                      >
                        + Row
                      </button>
                      <button
                        type="button"
                        className="mhz-td-table-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTableAction(block.id, 'del_row_bottom');
                        }}
                        title="Delete bottom row"
                      >
                        - Row
                      </button>
                      <span className="mhz-td-table-sep" />
                      <button
                        type="button"
                        className="mhz-td-table-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTableAction(block.id, 'add_col_right_btn');
                        }}
                        title="Add column at right"
                      >
                        + Col
                      </button>
                      <button
                        type="button"
                        className="mhz-td-table-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTableAction(block.id, 'del_col_right_btn');
                        }}
                        title="Delete rightmost column"
                      >
                        - Col
                      </button>
                    </div>
                  )}

                  {/* Real in-place contentEditable block */}
                  <ContentBlock
                    id={`edit-${block.id}`}
                    dataBlockId={block.id}
                    html={block.html || ''}
                    className={getBlockClassName(block)}
                    isEditing={true}
                    onInput={(e) => handleBlockInput(e, block.id)}
                    onKeyDown={(e) => handleBlockKeyDown(e, block.id)}
                    onFocus={() => {
                      if (isShiftSelectingRef.current) return;
                      setFocusedBlockId(block.id);
                      setSelectedBlockIds(prev => {
                        if (prev.size > 1 && prev.has(block.id)) return prev;
                        return new Set([block.id]);
                      });
                      setLastAnchorBlockId(block.id);
                    }}
                    onBlur={() => setFocusedBlockId(null)}
                    onClick={(e) => {
                      setFocusedBlockId(block.id);
                      handleSelectBlock(block.id, e);
                      const target = e.target as HTMLElement;
                      const cropWrapper = target.closest('.mhz-td-crop-wrapper');
                      const img = target.tagName === 'IMG' 
                        ? (target as HTMLImageElement) 
                        : (cropWrapper?.querySelector('img') as HTMLImageElement | null);

                      if (img) {
                        setSelectedImageInfo({
                          blockId: block.id,
                          target: img,
                          src: img.src,
                          originalSrc: img.getAttribute('data-original-src') || img.src
                        });
                      } else if (!cropWrapper && !target.closest('.mhz-td-image-toolbar') && !target.closest('.mhz-td-image-resize-handle')) {
                        setSelectedImageInfo(null);
                      }
                    }}
                    onMouseDown={(e) => handleBlockMouseDown(e, block.id)}
                    onMouseMove={(e) => handleBlockMouseMove(e, block.id)}
                    onMouseUp={() => handleBlockMouseUp(block.id)}
                    onContextMenu={(e) => handleBlockContextMenu(e, block.id)}
                  />

                  {/* Heading Fold Indicator Pill */}
                  {isHeading && isCollapsed && (
                    <span
                      className="mhz-td-fold-pill"
                      contentEditable={false}
                      title="Section folded. Click to unfold (Alt+→) / Unfold All (Alt+→×2)"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleHeadingFold(block.id);
                      }}
                    >
                      ···
                    </span>
                  )}
                </div>
              )}

              {/* Slash Command ('/') Menu Floating Popup (TreeDiadev-styled & Auto-Positioned) */}
              {slashMenuState && slashMenuState.blockId === block.id && (
                <div className={`mhz-td-slash-menu placement-${menuPlacement}`} onClick={(e) => e.stopPropagation()}>
                  {/* Top Inline Formatting Toolbar */}
                  <div className="mhz-td-menu-format-bar">
                    <button
                      className="mhz-td-menu-format-btn"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('bold', block.id)}
                      title="Bold (Ctrl+B)"
                    >
                      <Bold size={13} />
                    </button>
                    <button
                      className="mhz-td-menu-format-btn"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('italic', block.id)}
                      title="Italic (Ctrl+I)"
                    >
                      <Italic size={13} />
                    </button>
                    <button
                      className="mhz-td-menu-format-btn"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('underline', block.id)}
                      title="Underline (Ctrl+U)"
                    >
                      <Underline size={13} />
                    </button>
                    <button
                      className="mhz-td-menu-format-btn"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('strikeThrough', block.id)}
                      title="Strikethrough"
                    >
                      <Strikethrough size={13} />
                    </button>
                    <button
                      className="mhz-td-menu-format-btn danger"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('removeFormat', block.id)}
                      title="Clear Formatting"
                    >
                      <Eraser size={13} />
                    </button>
                  </div>

                  {/* 1. Main View (Only Turn into & Colors, exactly like MarkdownComp) */}
                  {slashMenuState.view === 'main' && !slashMenuState.filterText && (
                    <>
                      <div className="mhz-td-slash-header">Options</div>
                      {MAIN_MENU_ITEMS.map((item, idx) => {
                        const isActive = idx === slashMenuState.selectedIndex;
                        return (
                          <div
                            key={item.id}
                            className={`mhz-td-slash-item ${isActive ? 'active' : ''}`}
                            onMouseEnter={() => setSlashMenuState(s => s ? { ...s, selectedIndex: idx } : null)}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (item.isTurnInto) {
                                setSlashMenuState(s => s ? { ...s, view: 'turnInto', selectedIndex: 0 } : null);
                              } else if (item.isColors) {
                                setSlashMenuState(s => s ? { ...s, view: 'colors' } : null);
                                setColorNav({ col: 'text', row: 0 });
                              }
                            }}
                          >
                            <div className="mhz-td-slash-icon">{item.icon}</div>
                            <div className="mhz-td-slash-info">
                              <div className="mhz-td-slash-label">{item.label}</div>
                              {item.desc && <div className="mhz-td-slash-desc">{item.desc}</div>}
                            </div>
                            <ChevronRight size={13} style={{ color: '#64748b', marginLeft: 'auto' }} />
                          </div>
                        );
                      })}

                      <div
                        className="mhz-td-slash-item danger"
                        onClick={() => {
                          setSelectedBlockIds(new Set([block.id]));
                          deleteSelectedBlocks();
                        }}
                        style={{ marginTop: 2, borderTop: '1px solid rgba(148, 163, 184, 0.1)' }}
                      >
                        <div className="mhz-td-slash-icon"><Trash2 size={13} /></div>
                        <div className="mhz-td-slash-info">
                          <div className="mhz-td-slash-label">Delete Block</div>
                        </div>
                      </div>
                    </>
                  )}

                  {/* 2. Filtered Search Results */}
                  {slashMenuState.filterText && (
                    <>
                      <div className="mhz-td-slash-header">Matching Commands</div>
                      {getFilteredSlashCommands(slashMenuState.filterText).map((cmd, cIdx) => {
                        const isActive = cIdx === slashMenuState.selectedIndex;
                        return (
                          <div
                            key={cmd.id}
                            className={`mhz-td-slash-item ${isActive ? 'active' : ''}`}
                            onMouseEnter={() => setSlashMenuState(s => s ? { ...s, selectedIndex: cIdx } : null)}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (cmd.type === 'table') insertTable(block.id);
                              else executeSlashCommand(cmd, block.id);
                            }}
                          >
                            <div className="mhz-td-slash-icon">{cmd.icon}</div>
                            <div className="mhz-td-slash-info">
                              <div className="mhz-td-slash-label">{cmd.label}</div>
                              <div className="mhz-td-slash-desc">{cmd.description}</div>
                            </div>
                            <div className="mhz-td-slash-shortcut">{cmd.shortcut}</div>
                          </div>
                        );
                      })}
                      {getFilteredSlashCommands(slashMenuState.filterText).length === 0 && (
                        <div style={{ padding: '8px 12px', fontSize: '11px', color: '#64748b' }}>
                          No matching commands
                        </div>
                      )}
                    </>
                  )}

                  {/* 3. Turn into View (All Block Types & Table inside Turn into) */}
                  {slashMenuState.view === 'turnInto' && !slashMenuState.filterText && (
                    <>
                      <div className="mhz-td-menu-sub-header">
                        <button className="mhz-td-menu-back-btn" onClick={() => setSlashMenuState(s => s ? { ...s, view: 'main', selectedIndex: 0 } : null)}>
                          <ChevronLeft size={13} />
                        </button>
                        <span className="mhz-td-menu-sub-title">Turn into</span>
                        <span className="mhz-td-menu-esc-hint">ESC to back</span>
                      </div>
                      <div className="mhz-td-turn-into-list">
                        {TURN_INTO_ITEMS.map((cmd, cIdx) => {
                          const isActive = cIdx === slashMenuState.selectedIndex;
                          return (
                            <div
                              key={cmd.id}
                              className={`mhz-td-slash-item ${isActive ? 'active' : ''}`}
                              onMouseEnter={() => setSlashMenuState(s => s ? { ...s, selectedIndex: cIdx } : null)}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (cmd.type === 'table') insertTable(block.id);
                                else executeSlashCommand(cmd, block.id);
                              }}
                            >
                              <div className="mhz-td-slash-icon">{cmd.icon}</div>
                              <div className="mhz-td-slash-info">
                                <div className="mhz-td-slash-label">{cmd.label}</div>
                                <div className="mhz-td-slash-desc">{cmd.description}</div>
                              </div>
                              <div className="mhz-td-slash-shortcut">{cmd.shortcut}</div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {/* 4. Colors View (Keyboard & Click Selectable) */}
                  {slashMenuState.view === 'colors' && (
                    <>
                      <div className="mhz-td-menu-sub-header">
                        <button className="mhz-td-menu-back-btn" onClick={() => setSlashMenuState(s => s ? { ...s, view: 'main', selectedIndex: 1 } : null)}>
                          <ChevronLeft size={13} />
                        </button>
                        <span className="mhz-td-menu-sub-title">Colors</span>
                        <span className="mhz-td-menu-esc-hint">Arrows & Enter</span>
                      </div>
                      <div className="mhz-td-colors-container">
                        {/* TEXT COLORS */}
                        <div className="mhz-td-color-column">
                          <span className="mhz-td-color-column-title">TEXT</span>
                          <label className="mhz-td-custom-color-label" title="Custom text color" onMouseDown={(e) => e.preventDefault()}>
                            <div className="mhz-td-custom-color-rainbow" />
                            <input
                              type="color"
                              className="mhz-td-custom-color-input"
                              onChange={(e) => applyColor('text', e.target.value, block.id)}
                            />
                          </label>
                          <div className="mhz-td-color-swatches-grid">
                            {TEXT_COLORS_DARK.map((col, cIdx) => {
                              const isNavFocused = colorNav.col === 'text' && colorNav.row === cIdx;
                              return (
                                <button
                                  key={col}
                                  className={`mhz-td-color-swatch-btn ${isNavFocused ? 'focused' : ''}`}
                                  style={{ backgroundColor: col }}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => applyColor('text', col, block.id)}
                                  title={`Text color (${cIdx + 1})`}
                                >
                                  <span className="mhz-td-color-shortcut-tag" style={{ color: cIdx === 0 ? '#000' : '#fff' }}>
                                    {cIdx + 1}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div className="mhz-td-colors-divider" />

                        {/* BACKGROUND HIGHLIGHTS */}
                        <div className="mhz-td-color-column">
                          <span className="mhz-td-color-column-title">BACK</span>
                          <label className="mhz-td-custom-color-label" title="Custom background color" onMouseDown={(e) => e.preventDefault()}>
                            <div className="mhz-td-custom-color-rainbow" />
                            <input
                              type="color"
                              className="mhz-td-custom-color-input"
                              onChange={(e) => applyColor('bg', e.target.value, block.id)}
                            />
                          </label>
                          <div className="mhz-td-color-swatches-grid">
                            {BG_COLORS_DARK.map((col, cIdx) => {
                              const isNavFocused = colorNav.col === 'bg' && colorNav.row === cIdx;
                              return (
                                <button
                                  key={col}
                                  className={`mhz-td-color-swatch-btn ${isNavFocused ? 'focused' : ''}`}
                                  style={{ backgroundColor: col }}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => applyColor('bg', col, block.id)}
                                  title={`Background color (Shift+${cIdx + 1})`}
                                >
                                  <span className="mhz-td-color-shortcut-tag" style={{ color: '#fff' }}>
                                    S+{cIdx + 1}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Add New Block Button at Bottom */}
      <button
        className="mhz-td-add-btn"
        onClick={() => {
          const newId = generateId();
          const newBlock: Block = { id: newId, type: 'paragraph', html: '', indent: 0 };
          onUpdateBlocks([...blocks, newBlock]);
          focusBlock(newId, 0);
        }}
      >
        <Plus size={14} />
        <span>Add Block</span>
      </button>

      {/* Right-Click Floating Selection Context Menu (Bold, Italic, Underline, Strike, Colors) */}
      {contextMenuState && (
        <div
          className="mhz-td-context-menu"
          style={{ left: `${contextMenuState.x}px`, top: `${contextMenuState.y}px` }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
        >
          {/* Format Buttons Bar */}
          <div className="mhz-td-menu-format-bar">
            <button
              className="mhz-td-menu-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyFormatting('bold', contextMenuState.blockId)}
              title="Bold (Ctrl+B)"
            >
              <Bold size={13} />
            </button>
            <button
              className="mhz-td-menu-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyFormatting('italic', contextMenuState.blockId)}
              title="Italic (Ctrl+I)"
            >
              <Italic size={13} />
            </button>
            <button
              className="mhz-td-menu-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyFormatting('underline', contextMenuState.blockId)}
              title="Underline (Ctrl+U)"
            >
              <Underline size={13} />
            </button>
            <button
              className="mhz-td-menu-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyFormatting('strikeThrough', contextMenuState.blockId)}
              title="Strikethrough"
            >
              <Strikethrough size={13} />
            </button>
            <button
              className="mhz-td-menu-format-btn danger"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyFormatting('removeFormat', contextMenuState.blockId)}
              title="Clear Formatting"
            >
              <Eraser size={13} />
            </button>
            <span className="mhz-td-table-sep" />
            <button
              className="mhz-td-menu-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setBlocksAlign('left', contextMenuState.blockId)}
              title="Align Left (Ctrl+Shift+L)"
            >
              <AlignLeft size={13} />
            </button>
            <button
              className="mhz-td-menu-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setBlocksAlign('center', contextMenuState.blockId)}
              title="Align Center (Ctrl+Shift+E)"
            >
              <AlignCenter size={13} />
            </button>
            <button
              className="mhz-td-menu-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setBlocksAlign('right', contextMenuState.blockId)}
              title="Align Right (Ctrl+Shift+R)"
            >
              <AlignRight size={13} />
            </button>
          </div>

          {/* Colors Section */}
          <div className="mhz-td-colors-container">
            {/* TEXT COLORS */}
            <div className="mhz-td-color-column">
              <span className="mhz-td-color-column-title">TEXT</span>
              <label className="mhz-td-custom-color-label" title="Custom text color" onMouseDown={(e) => e.preventDefault()}>
                <div className="mhz-td-custom-color-rainbow" />
                <input
                  type="color"
                  className="mhz-td-custom-color-input"
                  onChange={(e) => applyColor('text', e.target.value, contextMenuState.blockId)}
                />
              </label>
              <div className="mhz-td-color-swatches-grid">
                {TEXT_COLORS_DARK.map((col, cIdx) => (
                  <button
                    key={col}
                    className="mhz-td-color-swatch-btn"
                    style={{ backgroundColor: col }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyColor('text', col, contextMenuState.blockId)}
                    title={`Text color (${cIdx + 1})`}
                  >
                    <span className="mhz-td-color-shortcut-tag" style={{ color: cIdx === 0 ? '#000' : '#fff' }}>
                      {cIdx + 1}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="mhz-td-colors-divider" />

            {/* BACKGROUND HIGHLIGHTS */}
            <div className="mhz-td-color-column">
              <span className="mhz-td-color-column-title">BACK</span>
              <label className="mhz-td-custom-color-label" title="Custom background color" onMouseDown={(e) => e.preventDefault()}>
                <div className="mhz-td-custom-color-rainbow" />
                <input
                  type="color"
                  className="mhz-td-custom-color-input"
                  onChange={(e) => applyColor('bg', e.target.value, contextMenuState.blockId)}
                />
              </label>
              <div className="mhz-td-color-swatches-grid">
                {BG_COLORS_DARK.map((col, cIdx) => (
                  <button
                    key={col}
                    className="mhz-td-color-swatch-btn"
                    style={{ backgroundColor: col }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyColor('bg', col, contextMenuState.blockId)}
                    title={`Background color (${cIdx + 1})`}
                  >
                    <span className="mhz-td-color-shortcut-tag" style={{ color: '#fff' }}>
                      {cIdx + 1}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Right-Click Grip Context Menu (Edit F2, Align, Colors, Indent, Outdent, Move Up, Move Down, Delete) */}
      {gripMenuState && (
        <div
          className="mhz-td-context-menu mhz-td-grip-menu"
          style={{ left: `${gripMenuState.x}px`, top: `${gripMenuState.y}px` }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="mhz-td-context-menu-title">
            Block Actions {selectedBlockIds.size > 1 ? `(${selectedBlockIds.size} Selected)` : ''}
          </div>

          {/* Block Align Bar */}
          <div className="mhz-td-menu-align-bar">
            <span className="mhz-td-align-bar-label">Align:</span>
            <button
              type="button"
              className="mhz-td-menu-format-btn"
              onClick={() => setBlocksAlign('left', gripMenuState.blockId)}
              title="Align Left (Ctrl+Shift+L)"
            >
              <AlignLeft size={13} />
            </button>
            <button
              type="button"
              className="mhz-td-menu-format-btn"
              onClick={() => setBlocksAlign('center', gripMenuState.blockId)}
              title="Align Center (Ctrl+Shift+E)"
            >
              <AlignCenter size={13} />
            </button>
            <button
              type="button"
              className="mhz-td-menu-format-btn"
              onClick={() => setBlocksAlign('right', gripMenuState.blockId)}
              title="Align Right (Ctrl+Shift+R)"
            >
              <AlignRight size={13} />
            </button>
          </div>

          <div className="mhz-td-context-divider" />

          <button
            className="mhz-td-context-menu-item"
            onClick={() => {
              handleToggleRawMarkdown(gripMenuState.blockId);
              setGripMenuState(null);
            }}
          >
            <Code2 size={13} />
            <span>{blocks.find(b => b.id === gripMenuState.blockId)?.isRaw ? 'Render Markdown' : 'Edit Raw Markdown'}</span>
            <span className="mhz-td-context-shortcut">F2</span>
          </button>
          <button
            className="mhz-td-context-menu-item"
            onClick={() => {
              const bId = gripMenuState.blockId;
              const x = gripMenuState.x;
              const y = gripMenuState.y;
              setGripMenuState(null);
              setContextMenuState({ x, y, blockId: bId });
            }}
          >
            <Palette size={13} />
            <span>Colors & Formatting</span>
          </button>
          <button
            className="mhz-td-context-menu-item"
            onClick={() => {
              indentSelectedBlocks(1);
              setGripMenuState(null);
            }}
          >
            <ChevronRight size={13} />
            <span>Indent</span>
            <span className="mhz-td-context-shortcut">Tab</span>
          </button>
          <button
            className="mhz-td-context-menu-item"
            onClick={() => {
              indentSelectedBlocks(-1);
              setGripMenuState(null);
            }}
          >
            <ChevronLeft size={13} />
            <span>Outdent</span>
            <span className="mhz-td-context-shortcut">Shift+Tab</span>
          </button>
          <div className="mhz-td-context-divider" />
          <button
            className="mhz-td-context-menu-item"
            onClick={() => {
              moveSelectedBlocks('up');
              setGripMenuState(null);
            }}
          >
            <ChevronUp size={13} />
            <span>Move Up</span>
            <span className="mhz-td-context-shortcut">Ctrl+↑</span>
          </button>
          <button
            className="mhz-td-context-menu-item"
            onClick={() => {
              moveSelectedBlocks('down');
              setGripMenuState(null);
            }}
          >
            <ChevronDown size={13} />
            <span>Move Down</span>
            <span className="mhz-td-context-shortcut">Ctrl+↓</span>
          </button>
          <div className="mhz-td-context-divider" />
          <button
            className="mhz-td-context-menu-item danger"
            onClick={() => {
              deleteSelectedBlocks();
              setGripMenuState(null);
            }}
          >
            <Trash2 size={13} />
            <span>Delete {selectedBlockIds.size > 1 ? `(${selectedBlockIds.size} Blocks)` : 'Block'}</span>
            <span className="mhz-td-context-shortcut">Del</span>
          </button>
        </div>
      )}

      {/* Table Context Menu (Row/Column Insert/Delete) */}
      {tableMenuState && (
        <div
          className="mhz-td-context-menu mhz-td-table-menu"
          style={{ left: `${tableMenuState.x}px`, top: `${tableMenuState.y}px` }}
        >
          <div className="mhz-td-context-menu-title">
            {tableMenuState.rowIndices.length > 1 || tableMenuState.colIndices.length > 1
              ? `Table Selection (${tableMenuState.rowIndices.length} Rows, ${tableMenuState.colIndices.length} Cols)`
              : `Table Cell (R${tableMenuState.rowIndex + 1}, C${tableMenuState.colIndex + 1})`}
          </div>

          {/* Column Alignment Toolbar */}
          <div className="mhz-td-menu-align-bar">
            <span className="mhz-td-align-bar-label">Col Align:</span>
            <button
              type="button"
              className="mhz-td-menu-format-btn"
              onClick={() => handleTableAction(tableMenuState.blockId, 'align_col_left', tableMenuState.rowIndex, tableMenuState.colIndex, tableMenuState.rowIndices, tableMenuState.colIndices)}
              title="Align Selected Columns Left"
            >
              <AlignLeft size={13} />
            </button>
            <button
              type="button"
              className="mhz-td-menu-format-btn"
              onClick={() => handleTableAction(tableMenuState.blockId, 'align_col_center', tableMenuState.rowIndex, tableMenuState.colIndex, tableMenuState.rowIndices, tableMenuState.colIndices)}
              title="Align Selected Columns Center"
            >
              <AlignCenter size={13} />
            </button>
            <button
              type="button"
              className="mhz-td-menu-format-btn"
              onClick={() => handleTableAction(tableMenuState.blockId, 'align_col_right', tableMenuState.rowIndex, tableMenuState.colIndex, tableMenuState.rowIndices, tableMenuState.colIndices)}
              title="Align Selected Columns Right"
            >
              <AlignRight size={13} />
            </button>
          </div>

          <div className="mhz-td-context-divider" />

          {/* Insert Line Break inside Cell */}
          <button
            type="button"
            className="mhz-td-context-menu-item"
            onClick={() => {
              const bId = tableMenuState.blockId;
              const rIdx = tableMenuState.rowIndex;
              const cIdx = tableMenuState.colIndex;
              setTableMenuState(null);
              setTimeout(() => {
                const el = document.getElementById(`edit-${bId}`);
                const table = el?.querySelector('table');
                const rows = table?.querySelectorAll('tr');
                if (rows && rIdx < rows.length) {
                  const targetCell = rows[rIdx].children[cIdx] as HTMLElement;
                  if (targetCell) {
                    focusCell(targetCell, 'end');
                    try {
                      document.execCommand('insertHTML', false, '<br>');
                    } catch {
                      targetCell.innerHTML += '<br>';
                    }
                    const updatedHtml = (table?.parentElement?.innerHTML || table?.outerHTML || '');
                    const current = blocksRef.current;
                    const idx = current.findIndex(b => b.id === bId);
                    if (idx !== -1 && updatedHtml) {
                      const next = [...current];
                      next[idx] = { ...next[idx], html: updatedHtml };
                      onUpdateBlocks(next);
                    }
                  }
                }
              }, 10);
            }}
          >
            <CornerDownLeft size={13} />
            <span>Insert Line Break</span>
            <span className="mhz-td-context-shortcut">Alt+Enter</span>
          </button>

          <div className="mhz-td-context-divider" />

          <button
            type="button"
            className="mhz-td-context-menu-item"
            onClick={() => handleTableAction(tableMenuState.blockId, 'add_row_above', tableMenuState.rowIndex, tableMenuState.colIndex)}
          >
            <ChevronUp size={13} />
            <span>Insert Row Above</span>
          </button>
          <button
            type="button"
            className="mhz-td-context-menu-item"
            onClick={() => handleTableAction(tableMenuState.blockId, 'add_row_below', tableMenuState.rowIndex, tableMenuState.colIndex)}
          >
            <ChevronDown size={13} />
            <span>Insert Row Below</span>
          </button>
          <button
            type="button"
            className="mhz-td-context-menu-item danger"
            onClick={() => handleTableAction(tableMenuState.blockId, 'del_row', tableMenuState.rowIndex, tableMenuState.colIndex, tableMenuState.rowIndices, tableMenuState.colIndices)}
          >
            <Trash2 size={13} />
            <span>Delete {tableMenuState.rowIndices.length > 1 ? `${tableMenuState.rowIndices.length} Rows` : 'Row'}</span>
          </button>
          <div className="mhz-td-context-divider" />
          <button
            type="button"
            className="mhz-td-context-menu-item"
            onClick={() => handleTableAction(tableMenuState.blockId, 'add_col_left', tableMenuState.rowIndex, tableMenuState.colIndex)}
          >
            <ChevronLeft size={13} />
            <span>Insert Column Left</span>
          </button>
          <button
            type="button"
            className="mhz-td-context-menu-item"
            onClick={() => handleTableAction(tableMenuState.blockId, 'add_col_right', tableMenuState.rowIndex, tableMenuState.colIndex)}
          >
            <ChevronRight size={13} />
            <span>Insert Column Right</span>
          </button>
          <button
            type="button"
            className="mhz-td-context-menu-item danger"
            onClick={() => handleTableAction(tableMenuState.blockId, 'del_col', tableMenuState.rowIndex, tableMenuState.colIndex, tableMenuState.rowIndices, tableMenuState.colIndices)}
          >
            <Trash2 size={13} />
            <span>Delete {tableMenuState.colIndices.length > 1 ? `${tableMenuState.colIndices.length} Columns` : 'Column'}</span>
          </button>
          <div className="mhz-td-context-divider" />
          <button
            type="button"
            className="mhz-td-context-menu-item danger"
            onClick={() => {
              const next = blocksRef.current.filter(b => b.id !== tableMenuState.blockId);
              onUpdateBlocks(next.length ? next : [{ id: generateId(), type: 'paragraph', html: '', indent: 0 }]);
              setTableMenuState(null);
            }}
          >
            <Trash2 size={13} />
            <span>Delete Table</span>
          </button>
        </div>
      )}

      {/* Floating Ghost Badge while Dragging Blocks */}
      {activeDragGhost && (
        <div
          className="mhz-td-drag-floating-ghost"
          style={{
            position: 'fixed',
            left: `${activeDragGhost.x + 14}px`,
            top: `${activeDragGhost.y - 12}px`,
            pointerEvents: 'none',
            zIndex: 99999,
          }}
        >
          ↕ {activeDragGhost.label}
        </div>
      )}

      {/* Floating Toolbar and Resize Handle for Selected Image rendered via Portal to document.body */}
      {selectedImageInfo && selectedImageInfo.target && createPortal(
        (() => {
          const cropWrapper = selectedImageInfo.target.closest('span[data-crop-rect]') as HTMLElement | null;
          const rectTarget = cropWrapper || selectedImageInfo.target;
          if (!document.body.contains(rectTarget)) return null;

          const targetRect = rectTarget.getBoundingClientRect();
          if (targetRect.width === 0 || targetRect.height === 0) return null;

          // If image is out of viewport, hide floating toolbar
          if (targetRect.bottom < 0 || targetRect.top > window.innerHeight || targetRect.right < 0 || targetRect.left > window.innerWidth) {
            return null;
          }

          const handleTop = targetRect.bottom - 7;
          const handleLeft = targetRect.right - 7;

          // Position directly below the image (or right above if near screen bottom)
          let toolbarTop = targetRect.bottom + 6;
          if (toolbarTop + 45 > window.innerHeight && targetRect.top > 50) {
            toolbarTop = Math.max(8, targetRect.top - 42);
          }
          const toolbarLeft = Math.max(16, Math.min(targetRect.left, window.innerWidth - 380));

          return (
            <>
              {/* Corner Resize Handle */}
              <div
                className="mhz-td-image-resize-handle"
                style={{
                  position: 'fixed',
                  top: `${handleTop}px`,
                  left: `${handleLeft}px`,
                  zIndex: 99999
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const editorZoom = getElementZoom(rectTarget.parentElement);
                  setIsResizingImage(true);
                  resizeDragRef.current = {
                    startX: e.clientX,
                    startWidth: targetRect.width / editorZoom,
                    blockId: selectedImageInfo.blockId,
                    imgEl: selectedImageInfo.target,
                    zoom: editorZoom
                  };
                }}
                title="Drag to resize image"
              />

              {/* Floating Image Action Toolbar */}
              <div
                className="mhz-td-image-toolbar"
                style={{
                  position: 'fixed',
                  top: `${toolbarTop}px`,
                  left: `${toolbarLeft}px`,
                  zIndex: 99998
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-1">IMG</span>
                <div className="mhz-td-image-toolbar-sep" />

                {/* Trim / Crop */}
                <button
                  type="button"
                  className="mhz-td-image-toolbar-btn"
                  onClick={() => {
                    const cropWrapper = selectedImageInfo.target.closest('span[data-crop-rect]') as HTMLElement | null;
                    const rectTarget = cropWrapper || selectedImageInfo.target;
                    const naturalW = selectedImageInfo.target.naturalWidth || 1;
                    const editorZoom = getElementZoom(rectTarget.parentElement);
                    const currentDisplayW = rectTarget.getBoundingClientRect().width / editorZoom;

                    const customWidthAttr = cropWrapper?.getAttribute('data-custom-width') || selectedImageInfo.target.getAttribute('data-custom-width');
                    const parsed = parseImageHash(selectedImageInfo.originalSrc);
                    const customWidth = customWidthAttr ? parseFloat(customWidthAttr) : parsed.customWidth;
                    const existingCrop = parsed.crop;
                    const baseUnscaledW = existingCrop ? existingCrop.width : naturalW;
                    const currentScale = customWidth
                      ? (customWidth / baseUnscaledW)
                      : (currentDisplayW < baseUnscaledW - 5 ? currentDisplayW / baseUnscaledW : 1.0);

                    setTrimmingImage({
                      src: selectedImageInfo.target.src,
                      originalSrc: selectedImageInfo.originalSrc,
                      blockId: selectedImageInfo.blockId,
                      target: selectedImageInfo.target,
                      currentScale
                    });
                    setSelectedImageInfo(null);
                  }}
                  title="Crop / Trim Image (MarhNote style)"
                >
                  <Crop size={14} className="text-blue-400" />
                  <span>Crop</span>
                </button>

                <div className="mhz-td-image-toolbar-sep" />

                {/* Quick Width Presets */}
                <button
                  type="button"
                  className="mhz-td-image-toolbar-btn"
                  onClick={() => handleSetImageWidthPercent(selectedImageInfo.blockId, selectedImageInfo.target, 0.25)}
                  title="25% width"
                >
                  25%
                </button>
                <button
                  type="button"
                  className="mhz-td-image-toolbar-btn"
                  onClick={() => handleSetImageWidthPercent(selectedImageInfo.blockId, selectedImageInfo.target, 0.5)}
                  title="50% width"
                >
                  50%
                </button>
                <button
                  type="button"
                  className="mhz-td-image-toolbar-btn"
                  onClick={() => handleSetImageWidthPercent(selectedImageInfo.blockId, selectedImageInfo.target, 0.75)}
                  title="75% width"
                >
                  75%
                </button>
                <button
                  type="button"
                  className="mhz-td-image-toolbar-btn"
                  onClick={() => handleSetImageWidthPercent(selectedImageInfo.blockId, selectedImageInfo.target, 1.0)}
                  title="100% full width"
                >
                  100%
                </button>

                {/* Reset button */}
                <button
                  type="button"
                  className="mhz-td-image-toolbar-btn"
                  onClick={() => handleResetImage(selectedImageInfo.blockId, selectedImageInfo.target)}
                  title="Reset Crop and Size"
                >
                  <RotateCcw size={13} className="text-amber-400" />
                </button>

                <div className="mhz-td-image-toolbar-sep" />

                {/* Open Folder in Windows Explorer */}
                <button
                  type="button"
                  className="mhz-td-image-toolbar-btn"
                  onClick={() => handleOpenImageFolder(selectedImageInfo.originalSrc)}
                  title="Open containing folder in Explorer"
                >
                  <FolderOpen size={14} className="text-emerald-400" />
                </button>

                {/* Edit Raw Markdown (F2) */}
                <button
                  type="button"
                  className="mhz-td-image-toolbar-btn"
                  onClick={() => {
                    handleToggleRawMarkdown(selectedImageInfo.blockId);
                    setSelectedImageInfo(null);
                  }}
                  title="Edit Raw Markdown (F2)"
                >
                  <Code2 size={14} className="text-purple-400" />
                  <span>F2</span>
                </button>

                <div className="mhz-td-image-toolbar-sep" />

                {/* Delete Block */}
                <button
                  type="button"
                  className="mhz-td-image-toolbar-btn hover:text-red-400"
                  onClick={() => {
                    const next = blocksRef.current.filter(b => b.id !== selectedImageInfo.blockId);
                    onUpdateBlocks(next.length ? next : [{ id: generateId(), type: 'paragraph', html: '', indent: 0 }]);
                    setSelectedImageInfo(null);
                  }}
                  title="Delete image block"
                >
                  <Trash2 size={14} className="text-red-400" />
                </button>
              </div>
            </>
          );
        })(),
        document.body
      )}

      {/* In-Place Image Crop Overlay (Directly in Editor) */}
      {trimmingImage && (
        <InPlaceCropOverlay
          blockId={trimmingImage.blockId}
          target={trimmingImage.target}
          src={trimmingImage.src}
          originalSrc={trimmingImage.originalSrc}
          currentScale={trimmingImage.currentScale}
          baseDir={baseDir}
          onClose={() => setTrimmingImage(null)}
          onResetCrop={() => {
            handleUpdateImageBlock(trimmingImage.blockId, trimmingImage.target, {
              clearCrop: true,
              clearWidth: true
            });
            setTrimmingImage(null);
          }}
          onApplyCrop={(cropPx, targetWidth) => {
            const cropString = `${cropPx.x},${cropPx.y},${cropPx.width},${cropPx.height}`;
            handleUpdateImageBlock(trimmingImage.blockId, trimmingImage.target, {
              crop: cropString,
              width: targetWidth,
              clearWidth: !targetWidth
            });
            setTrimmingImage(null);
          }}
          onSaveAsFile={(newRelPath, targetWidth) => {
            const currentBlocks = blocksRef.current;
            const idx = currentBlocks.findIndex(b => b.id === trimmingImage.blockId);
            if (idx !== -1) {
              const alt = trimmingImage.target.getAttribute('alt') || '';
              const widthHash = targetWidth ? `#width=${targetWidth}` : '';
              const newHtml = renderImageHtml(`${newRelPath}${widthHash}`, alt, '', baseDir);
              const newBlocks = [...currentBlocks];
              newBlocks[idx] = { ...currentBlocks[idx], html: newHtml, isRaw: false };
              onUpdateBlocks(newBlocks);
            }
            setTrimmingImage(null);
          }}
        />
      )}
    </div>
  );
};
