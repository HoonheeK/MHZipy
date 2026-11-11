import { marked } from 'marked';
import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * Resolves a local or relative image path to a Tauri asset protocol URL for safe WebView rendering.
 */
export const resolveLocalImageSrc = (src: string, baseDir?: string): string => {
  if (!src) return '';
  if (
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('data:') ||
    src.startsWith('asset://') ||
    src.startsWith('https://asset.localhost') ||
    src.startsWith('http://asset.localhost')
  ) {
    return src;
  }
  let absPath = src;
  if (absPath.startsWith('file:///')) {
    absPath = decodeURIComponent(absPath.slice(8));
  } else if (absPath.startsWith('file://')) {
    absPath = decodeURIComponent(absPath.slice(7));
  }

  const isWindowsAbsolute = /^[a-zA-Z]:[/\\]/.test(absPath);
  const isPosixAbsolute = absPath.startsWith('/');
  if (!isWindowsAbsolute && !isPosixAbsolute && baseDir) {
    const cleanRel = absPath.replace(/^\.[/\\]/, '');
    const cleanBase = baseDir.replace(/[/\\]$/, '');
    absPath = `${cleanBase}/${cleanRel}`;
  }

  try {
    return convertFileSrc(absPath);
  } catch {
    return src;
  }
};

export interface ParsedImageInfo {
  path: string;
  originalSrc: string;
  crop?: { x: number; y: number; width: number; height: number };
  customWidth?: number;
}

/**
 * Parses image URL and extracts hash parameters (#crop=x,y,w,h, #width=300, etc.)
 */
export const parseImageHash = (href: string): ParsedImageInfo => {
  if (!href) return { path: '', originalSrc: '' };
  const [path, hash] = href.split('#');
  let crop: { x: number; y: number; width: number; height: number } | undefined;
  let customWidth: number | undefined;

  if (hash) {
    const decodedHash = decodeURIComponent(hash);
    const cropMatch = decodedHash.match(/(?:^|[&?])crop=([0-9.,]+)/i);
    if (cropMatch) {
      const parts = cropMatch[1].split(',').map(p => parseFloat(p.trim()));
      if (parts.length === 4 && !parts.some(isNaN) && parts[2] > 0 && parts[3] > 0) {
        crop = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
      }
    }

    const widthMatch = decodedHash.match(/(?:^|[&?])width=([0-9.]+)/i);
    if (widthMatch) {
      const w = parseFloat(widthMatch[1]);
      if (!isNaN(w) && w > 0) {
        customWidth = w;
      }
    }
  }

  return { path, originalSrc: href, crop, customWidth };
};

/**
 * Renders an image as HTML with optional crop wrapper span or custom width styling.
 */
export const renderImageHtml = (href: string, alt: string = '', title: string = '', baseDir?: string): string => {
  if (!href) return '';
  const { path, originalSrc, crop, customWidth } = parseImageHash(href);
  const resolvedSrc = resolveLocalImageSrc(path, baseDir);

  const titleAttr = title ? ` title="${title}"` : '';
  const altAttr = ` alt="${alt || ''}"`;

  if (crop) {
    const { x, y, width: w, height: h } = crop;
    const scale = customWidth ? customWidth / w : 1;
    const cropData = `data-crop-rect="${x},${y},${w},${h}"`;
    const widthData = customWidth ? ` data-custom-width="${customWidth}"` : '';

    const zoomStyle = scale !== 1 ? ` zoom: ${scale};` : '';
    const containerStyle = `display: inline-block; overflow: hidden; position: relative; width: ${w}px; height: ${h}px;${zoomStyle} max-width: 100%; vertical-align: middle;`;
    const imgStyle = `position: absolute; max-width: none; width: auto; height: auto; left: -${x}px; top: -${y}px;`;

    return `<span class="mhz-td-crop-wrapper" style="${containerStyle}" ${cropData}${widthData}><img src="${resolvedSrc}"${altAttr}${titleAttr} data-original-src="${originalSrc}" ${cropData} style="${imgStyle}" /></span>`;
  }

  if (customWidth) {
    const imgStyle = `width: ${customWidth}px; max-width: 100%; height: auto;`;
    return `<img src="${resolvedSrc}"${altAttr}${titleAttr} data-original-src="${originalSrc}" data-custom-width="${customWidth}" style="${imgStyle}" />`;
  }

  return `<img src="${resolvedSrc}"${altAttr}${titleAttr} data-original-src="${originalSrc}" />`;
};

export type BlockType =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'quote'
  | 'list'
  | 'checkbox'
  | 'divider'
  | 'code'
  | 'table';

export interface Block {
  id: string;
  type: BlockType;
  html: string;
  checked?: boolean;
  listType?: 'ul' | 'ol';
  indent: number;
  customId?: string;
  isRaw?: boolean;
  align?: 'left' | 'center' | 'right';
}

export const generateId = () => Math.random().toString(36).substring(2, 11);

/**
 * Converts HTML element tree back to Markdown syntax.
 * Direct implementation from TreeDiadev's markdownUtils.ts with image asset decoding & relative path preservation.
 */
export const htmlToMarkdown = (html: string, baseDir?: string): string => {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html.replace(/\u200B/g, ''); // Remove zero-width spaces

  const processChildren = (node: Node): string => {
    return Array.from(node.childNodes).map(child => processNode(child)).join('');
  };

  const processNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as HTMLElement;
    const tagName = el.tagName.toLowerCase();
    const content = processChildren(el);

    switch (tagName) {
      case 'strong':
      case 'b':
        return `**${content}**`;
      case 'em':
      case 'i':
        return `*${content}*`;
      case 'del':
      case 's':
      case 'strike':
        return `~~${content}~~`;
      case 'u':
        return `<u>${content}</u>`;
      case 'code':
        return `\`${content}\``;
      case 'br':
        return '<br>';
      case 'span': {
        // If this span is an image crop container, do NOT wrap in <span> tags; let the <img> inside serialize cleanly
        if (el.hasAttribute('data-crop-rect') || el.classList.contains('mhz-td-crop-wrapper')) {
          return content;
        }
        const style = el.getAttribute('style') || '';
        if (style) {
          return `<span style="${style}">${content}</span>`;
        }
        return content;
      }
      case 'a': {
        let href = el.getAttribute('href') || '';
        if (href.startsWith('#')) {
          try {
            href = decodeURIComponent(href);
          } catch {}
        }
        return `[${content}](${href})`;
      }
      case 'img': {
        let src = el.getAttribute('data-original-src') || el.getAttribute('src') || '';
        const alt = el.getAttribute('alt') || '';
        const title = el.getAttribute('title');

        // Check if there is data-crop-rect or data-custom-width on img or parent crop wrapper
        const cropRect = el.getAttribute('data-crop-rect') || el.closest('span[data-crop-rect]')?.getAttribute('data-crop-rect');
        const customWidth = el.getAttribute('data-custom-width') || el.closest('span[data-custom-width]')?.getAttribute('data-custom-width');

        // Clean up src if it's an asset URL (Tauri convertFileSrc URL)
        if (src.startsWith('http://asset.localhost/') || src.startsWith('https://asset.localhost/')) {
          try {
            const u = new URL(src);
            let p = decodeURIComponent(u.pathname);
            if (/^\/[a-zA-Z]:/.test(p)) p = p.substring(1);
            src = p + (u.hash || '');
          } catch {}
        }

        // Parse clean path and hash
        let [cleanPath, existingHash] = src.split('#');
        let hash = existingHash ? `#${existingHash}` : '';

        // If cropRect or customWidth are present, ensure they are in hash
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

        src = `${finalPath}${hash}`;
        return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
      }
      case 'table': {
        const trs = Array.from(el.querySelectorAll('tr'));
        const allHeaderCells = Array.from(el.querySelectorAll('th, td'));
        const hasCustomWidth = allHeaderCells.some(c => !!(c as HTMLElement).style.width || !!(c as HTMLElement).style.minWidth || c.hasAttribute('width'));
        if (hasCustomWidth) {
          // If table has custom widths, serialize as standard HTML table so widths are preserved across save & reload
          const clone = el.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('.mhz-td-col-resizing').forEach(c => c.classList.remove('mhz-td-col-resizing'));
          return clone.outerHTML;
        }

        const tableRows: string[] = [];
        trs.forEach((tr, i) => {
          const cells = Array.from(tr.querySelectorAll('th, td'));
          const rowContent = cells.map(c => processChildren(c).trim()).join(' | ');
          tableRows.push(`| ${rowContent} |`);

          if (i === 0) {
            const isHeader = tr.parentElement?.tagName.toLowerCase() === 'thead' || tr.querySelector('th');
            if (isHeader) {
              const separator = cells.map(c => {
                const align = (c.getAttribute('align') || (c as HTMLElement).style.textAlign || '').toLowerCase();
                if (align === 'center') return ':---:';
                if (align === 'right') return '---:';
                if (align === 'left') return ':---';
                return '---';
              }).join(' | ');
              tableRows.push(`| ${separator} |`);
            }
          }
        });
        return tableRows.join('\n');
      }
      case 'thead':
      case 'tbody':
      case 'tfoot':
      case 'tr':
      case 'th':
      case 'td':
        return '';
      default:
        return content;
    }
  };

  return processChildren(div);
};

/**
 * Returns appropriate CSS class names for a block depending on its type.
 */
export const getBlockClassName = (block: { type: string; isRaw?: boolean; align?: 'left' | 'center' | 'right' }) => {
  let baseClasses = 'mhz-td-content-block';

  if (block.isRaw) {
    baseClasses += ' mhz-td-raw-block';
  }

  if (block.align === 'center') {
    baseClasses += ' mhz-td-align-center';
  } else if (block.align === 'right') {
    baseClasses += ' mhz-td-align-right';
  } else if (block.align === 'left') {
    baseClasses += ' mhz-td-align-left';
  }

  switch (block.type) {
    case 'h1': return `${baseClasses} mhz-td-h1`;
    case 'h2': return `${baseClasses} mhz-td-h2`;
    case 'h3': return `${baseClasses} mhz-td-h3`;
    case 'h4': return `${baseClasses} mhz-td-h4`;
    case 'h5': return `${baseClasses} mhz-td-h5`;
    case 'h6': return `${baseClasses} mhz-td-h6`;
    case 'quote': return `${baseClasses} mhz-td-quote`;
    case 'list': return `${baseClasses} mhz-td-list`;
    case 'checkbox': return `${baseClasses} mhz-td-checkbox`;
    case 'code': return `${baseClasses} mhz-td-code`;
    case 'divider': return `${baseClasses} mhz-td-divider`;
    case 'table': return `${baseClasses} mhz-td-table`;
    default: return `${baseClasses} mhz-td-p`;
  }
};

/**
 * Splits raw markdown text into structured Blocks.
 * Directly based on TreeDiadev's parseMarkdownToBlocks.
 */
export const parseMarkdownToBlocks = (md: string, baseDir?: string): Block[] => {
  if (!md || !md.trim()) {
    return [{ id: generateId(), type: 'paragraph', html: '', indent: 0 }];
  }

  const normalizedMd = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedMd.split('\n');
  const intermediateBlocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Empty lines outside code blocks: preserve as empty paragraph blocks so line counts and blank lines are maintained accurately
    if (trimmed === '' && !line.startsWith('    ') && !line.startsWith('\t')) {
      intermediateBlocks.push({
        id: generateId(),
        type: 'paragraph',
        html: '',
        indent: 0,
        isRaw: false
      });
      i++;
      continue;
    }

    // Fenced Code Blocks (``` ... ```)
    if (trimmed.startsWith('```')) {
      let hasClosing = false;
      let searchIndex = i + 1;
      while (searchIndex < lines.length) {
        if (lines[searchIndex].trim().startsWith('```')) {
          hasClosing = true;
          break;
        }
        searchIndex++;
      }

      if (hasClosing) {
        const codeLines: string[] = [];
        i++; // skip opening ```
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        const codeContent = codeLines.join('\n');
        const escapedHtml = codeContent
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

        intermediateBlocks.push({
          id: generateId(),
          type: 'code',
          html: escapedHtml.replace(/\n/g, '<br>'),
          indent: 0,
        });
        if (i < lines.length) i++; // skip closing ```
        continue;
      }
    }

    // Markdown Tables
    if (trimmed.startsWith('|')) {
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && nextLine.startsWith('|') && /^[|\s-:]+$/.test(nextLine) && nextLine.includes('-')) {
        let tableMd = line;
        let j = i + 1;
        while (j < lines.length) {
          const next = lines[j].trim();
          if (!next.startsWith('|')) break;
          tableMd += '\n' + lines[j];
          j++;
        }

        const html = (marked.parse(tableMd) as string).trim();

        intermediateBlocks.push({
          id: generateId(),
          type: 'table',
          html: html,
          indent: 0
        });

        i = j;
        continue;
      }
    }
    
    // HTML Tables (<table ...> ... </table>)
    if (trimmed.startsWith('<table')) {
      let tableHtml = line;
      let j = i + 1;
      let closed = trimmed.includes('</table>');
      while (j < lines.length && !closed) {
        tableHtml += '\n' + lines[j];
        if (lines[j].includes('</table>')) {
          closed = true;
        }
        j++;
      }

      intermediateBlocks.push({
        id: generateId(),
        type: 'table',
        html: tableHtml.trim(),
        indent: 0
      });

      i = j;
      continue;
    }

    const id = generateId();
    let type: BlockType = 'paragraph';
    let content = line;
    let checked = false;
    let listType: 'ul' | 'ol' | undefined;
    let align: 'left' | 'center' | 'right' | undefined;

    // Detect align wrapper like <p align="center">...</p>
    const alignTagMatch = trimmed.match(/^<(?:p|div)\s+align=["'](left|center|right)["']>(.*?)<\/(?:p|div)>$/i);
    if (alignTagMatch) {
      align = alignTagMatch[1].toLowerCase() as 'left' | 'center' | 'right';
      content = alignTagMatch[2];
    }

    // Calculate Indent from leading spaces / tabs
    const leadingWhitespace = line.match(/^\s*/)?.[0] || '';
    let indent = 0;
    let spaceCount = 0;
    for (const char of leadingWhitespace) {
      if (char === '\t') indent++;
      else if (char === ' ') spaceCount++;
    }
    indent += Math.floor(spaceCount / 2);

    // ATX Headings: #, ##, ###, ####, #####, ######
    const headerMatch = trimmed.match(/^(#{1,6})(?:\s+|$)(.*)$/s);
    if (headerMatch) {
      const level = headerMatch[1].length;
      type = `h${level}` as BlockType;
      content = headerMatch[2] || '';
      indent = 0;
    }
    else if (trimmed.startsWith('> ')) {
      type = 'quote';
      content = trimmed.slice(2);
      indent = 0;
    }
    else if (trimmed === '- [ ]' || trimmed === '[ ]' || trimmed.startsWith('- [ ] ') || trimmed.startsWith('[ ] ')) {
      type = 'checkbox';
      content = trimmed.startsWith('- ') ? trimmed.slice(6) : trimmed.slice(4);
      checked = false;
    }
    else if (trimmed === '- [x]' || trimmed === '[x]' || trimmed.startsWith('- [x] ') || trimmed.startsWith('[x] ')) {
      type = 'checkbox';
      content = trimmed.startsWith('- ') ? trimmed.slice(6) : trimmed.slice(4);
      checked = true;
    }
    else if (trimmed === '-' || trimmed === '*' || trimmed === '+' || trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('+ ')) {
      type = 'list';
      listType = 'ul';
      content = trimmed.replace(/^[-*+]\s*/, '');
    }
    else if (/^\d+\.(\s|$)/.test(trimmed)) {
      type = 'list';
      listType = 'ol';
      content = trimmed.replace(/^\d+\.(\s|$)/, '');
    }
    else if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
      type = 'divider';
      content = '';
      indent = 0;
    }
    else if (line.startsWith('    ') || line.startsWith('\t')) {
      type = 'code';
      content = line;
      indent = 0;
    }

    // Convert inline markdown to HTML
    let html = content;
    if (type === 'code') {
      html = content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    } else {
      html = marked.parseInline(content) as string;

      // TreeDiadev fallback for bold/italic syntax that marked.js might miss
      if (html.includes('**')) {
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      }
      if (html.includes('*')) {
        html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
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
    }

    intermediateBlocks.push({ id, type, html, indent, checked, listType, isRaw: false, align });
    i++;
  }

  // Post-processing to handle list item continuations
  const blocks: Block[] = [];
  for (const currentBlock of intermediateBlocks) {
    const prevBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;

    if (
      prevBlock &&
      (prevBlock.type === 'list' || prevBlock.type === 'checkbox') &&
      currentBlock.type === 'paragraph' &&
      currentBlock.indent > prevBlock.indent
    ) {
      prevBlock.html += `<br>${currentBlock.html}`;
    } else {
      blocks.push(currentBlock);
    }
  }

  return blocks.length > 0 ? blocks : [{ id: generateId(), type: 'paragraph', html: '', indent: 0 }];
};

/**
 * Serializes structured Blocks back into standard Markdown text.
 * Directly based on TreeDiadev's serializeBlocksToMarkdown.
 */
export const serializeBlocksToMarkdown = (blocks: Block[], baseDir?: string): string => {
  const lines: string[] = [];

  for (const b of blocks) {
    if (b.type === 'code') {
      let textContent = b.html
        .replace(/\r?\n/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;/gi, " ")
        .replace(/\u00A0/g, " ");

      textContent = textContent.replace(/^\n+/, '').replace(/\n+$/, '');
      lines.push(`\`\`\`\n${textContent}\n\`\`\``);
      continue;
    }

    if (b.type === 'divider') {
      lines.push('---');
      continue;
    }

    let mdContent = '';
    if (b.isRaw) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = b.html
        .replace(/\r?\n/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<div>/gi, '')
        .replace(/<\/p>/gi, '\n')
        .replace(/<p>/gi, '');
      mdContent = (tempDiv.textContent || tempDiv.innerText || '').replace(/\u00A0/g, ' ');
    } else {
      mdContent = htmlToMarkdown(b.html, baseDir);
    }

    const prefix = '\t'.repeat(b.indent);
    let lineContent = '';

    switch (b.type) {
      case 'h1': lineContent = `${prefix}# ${mdContent}`; break;
      case 'h2': lineContent = `${prefix}## ${mdContent}`; break;
      case 'h3': lineContent = `${prefix}### ${mdContent}`; break;
      case 'h4': lineContent = `${prefix}#### ${mdContent}`; break;
      case 'h5': lineContent = `${prefix}##### ${mdContent}`; break;
      case 'h6': lineContent = `${prefix}###### ${mdContent}`; break;
      case 'quote': lineContent = `${prefix}> ${mdContent}`; break;
      case 'list': lineContent = `${prefix}${b.listType === 'ol' ? `1. ${mdContent}` : `- ${mdContent}`}`; break;
      case 'checkbox': lineContent = `${prefix}[${b.checked ? 'x' : ' '}] ${mdContent}`; break;
      default: lineContent = `${prefix}${mdContent}`;
    }

    if (b.align && b.align !== 'left' && lineContent.trim()) {
      lineContent = `<p align="${b.align}">${lineContent}</p>`;
    }

    lines.push(lineContent);
  }

  // Join blocks with single newlines so no unexpected blank lines are injected
  return lines.join('\n');
};
