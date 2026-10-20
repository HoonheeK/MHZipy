import { marked } from 'marked';

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
}

export const generateId = () => Math.random().toString(36).substring(2, 11);

/**
 * Converts HTML element tree back to Markdown syntax.
 * Direct implementation from TreeDiadev's markdownUtils.ts.
 */
export const htmlToMarkdown = (html: string): string => {
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
      case 'table': {
        const tableRows: string[] = [];
        const trs = Array.from(el.querySelectorAll('tr'));
        trs.forEach((tr, i) => {
          const cells = Array.from(tr.querySelectorAll('th, td'));
          const rowContent = cells.map(c => processChildren(c).trim()).join(' | ');
          tableRows.push(`| ${rowContent} |`);

          if (i === 0) {
            const isHeader = tr.parentElement?.tagName.toLowerCase() === 'thead' || tr.querySelector('th');
            if (isHeader) {
              const separator = cells.map(c => {
                const align = c.getAttribute('align');
                if (align === 'center') return ':---:';
                if (align === 'right') return '---:';
                return '---';
              }).join(' | ');
              tableRows.push(`| ${separator} |`);
            }
          }
        });
        return '\n' + tableRows.join('\n') + '\n';
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
export const getBlockClassName = (block: { type: string; isRaw?: boolean }) => {
  let baseClasses = 'mhz-td-content-block';

  if (block.isRaw) {
    baseClasses += ' mhz-td-raw-block';
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
export const parseMarkdownToBlocks = (md: string): Block[] => {
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

    // Skip empty lines outside code blocks
    if (trimmed === '' && !line.startsWith('    ') && !line.startsWith('\t')) {
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

    const id = generateId();
    let type: BlockType = 'paragraph';
    let content = line;
    let checked = false;
    let listType: 'ul' | 'ol' | undefined;

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
    }

    intermediateBlocks.push({ id, type, html, indent, checked, listType, isRaw: false });
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
export const serializeBlocksToMarkdown = (blocks: Block[]): string => {
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
      mdContent = htmlToMarkdown(b.html);
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

    lines.push(lineContent);
  }

  // Join blocks cleanly: between list items single newline, between headers/paragraphs double newlines
  let result = '';
  for (let i = 0; i < blocks.length; i++) {
    const curr = lines[i];
    const currBlock = blocks[i];
    const nextBlock = blocks[i + 1];
    result += curr;

    if (i < blocks.length - 1) {
      const isCurrList = currBlock.type === 'list' || currBlock.type === 'checkbox';
      const isNextList = nextBlock && (nextBlock.type === 'list' || nextBlock.type === 'checkbox');
      if (isCurrList && isNextList) {
        result += '\n';
      } else {
        result += '\n\n';
      }
    }
  }

  return result;
};
