import { Block, htmlToMarkdown, parseMarkdownToBlocks } from './markdownBlockUtils';

export type HeadingStyle = 'brackets' | 'numbered' | 'underline' | 'markdown' | 'plain';
export type CheckboxStyle = 'unicode_box' | 'bracket_v' | 'unicode_circle' | 'markdown';
export type ListStyle = 'bullet' | 'middle_dot' | 'dash' | 'star' | 'indent';
export type OrderedListStyle = 'dot' | 'paren' | 'brackets' | 'circle_num';
export type QuoteStyle = 'bar' | 'quotes' | 'markdown' | 'indent';
export type TableStyle = 'tsv' | 'ascii' | 'markdown';
export type InlineStyle = 'clean' | 'keep' | 'bracket';

export interface MdToTextRules {
  id: string;
  name: string;
  headingStyle: HeadingStyle;
  checkboxStyle: CheckboxStyle;
  listStyle: ListStyle;
  orderedListStyle: OrderedListStyle;
  quoteStyle: QuoteStyle;
  tableStyle: TableStyle;
  inlineStyle: InlineStyle;
  includeLinkUrl: boolean;
  cleanBlankLines: boolean;
}

export const PRESET_RULES: Record<string, MdToTextRules> = {
  business: {
    id: 'business',
    name: '비즈니스 보고서형 (Business Report)',
    headingStyle: 'brackets',
    checkboxStyle: 'unicode_box',
    listStyle: 'bullet',
    orderedListStyle: 'paren',
    quoteStyle: 'bar',
    tableStyle: 'tsv',
    inlineStyle: 'clean',
    includeLinkUrl: true,
    cleanBlankLines: false,
  },
  numbered: {
    id: 'numbered',
    name: '체계적 번호 개요형 (Numbered Outline)',
    headingStyle: 'numbered',
    checkboxStyle: 'bracket_v',
    listStyle: 'middle_dot',
    orderedListStyle: 'dot',
    quoteStyle: 'bar',
    tableStyle: 'tsv',
    inlineStyle: 'clean',
    includeLinkUrl: false,
    cleanBlankLines: false,
  },
  markdown: {
    id: 'markdown',
    name: '표준 마크다운 유지형 (Standard Markdown)',
    headingStyle: 'markdown',
    checkboxStyle: 'markdown',
    listStyle: 'dash',
    orderedListStyle: 'dot',
    quoteStyle: 'markdown',
    tableStyle: 'markdown',
    inlineStyle: 'keep',
    includeLinkUrl: true,
    cleanBlankLines: false,
  },
  minimal: {
    id: 'minimal',
    name: '깔끔한 플레인 텍스트형 (Clean Plain Text)',
    headingStyle: 'plain',
    checkboxStyle: 'bracket_v',
    listStyle: 'middle_dot',
    orderedListStyle: 'dot',
    quoteStyle: 'indent',
    tableStyle: 'ascii',
    inlineStyle: 'clean',
    includeLinkUrl: false,
    cleanBlankLines: true,
  },
};

const CIRCLE_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];

/**
 * Strips or converts inline Markdown formatting (bold, italic, strike, code, link)
 */
export function formatInlineText(mdText: string, rules: MdToTextRules): string {
  if (!mdText) return '';
  let res = mdText;

  if (rules.inlineStyle === 'clean') {
    // Bold: **text** or __text__ -> text
    res = res.replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1');
    // Italic: *text* or _text_ -> text
    res = res.replace(/\*(.*?)\*/g, '$1').replace(/(^|\W)_(.*?)_(\W|$)/g, '$1$2$3');
    // Strikethrough: ~~text~~ -> text
    res = res.replace(/~~(.*?)~~/g, '$1');
    // Inline code: `code` -> 'code'
    res = res.replace(/`([^`]+)`/g, '$1');
  } else if (rules.inlineStyle === 'bracket') {
    // Bold -> [text]
    res = res.replace(/\*\*(.*?)\*\*/g, '[$1]').replace(/__(.*?)__/g, '[$1]');
    res = res.replace(/\*(.*?)\*/g, '$1');
    res = res.replace(/~~(.*?)~~/g, '$1');
    res = res.replace(/`([^`]+)`/g, "'$1'");
  }

  // Links: [text](url)
  if (rules.includeLinkUrl) {
    res = res.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  } else {
    res = res.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  }

  // HTML tags cleanup if any
  res = res.replace(/<[^>]+>/g, '');

  return res;
}

/**
 * Format table HTML or Markdown rows into TSV, ASCII grid, or standard Markdown
 */
function formatTableBlock(html: string, rules: MdToTextRules): string {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  const rows = Array.from(tempDiv.querySelectorAll('tr'));
  if (rows.length === 0) {
    // Fallback if raw text
    return tempDiv.textContent || '';
  }

  const tableData: string[][] = rows.map(tr => {
    const cells = Array.from(tr.querySelectorAll('th, td'));
    return cells.map(c => (c.textContent || '').trim().replace(/\u00A0/g, ' '));
  });

  if (rules.tableStyle === 'tsv') {
    return tableData.map(row => row.join('\t')).join('\n');
  }

  if (rules.tableStyle === 'ascii') {
    const colCount = Math.max(...tableData.map(r => r.length), 0);
    const colWidths = Array(colCount).fill(0);
    tableData.forEach(row => {
      row.forEach((cell, idx) => {
        // Simple length calculation (Korean chars count as ~1.7)
        let visualLen = 0;
        for (let i = 0; i < cell.length; i++) {
          visualLen += cell.charCodeAt(i) > 127 ? 2 : 1;
        }
        if (visualLen > colWidths[idx]) colWidths[idx] = visualLen;
      });
    });

    const padCell = (text: string, width: number) => {
      let visualLen = 0;
      for (let i = 0; i < text.length; i++) {
        visualLen += text.charCodeAt(i) > 127 ? 2 : 1;
      }
      return text + ' '.repeat(Math.max(0, width - visualLen));
    };

    const separator = '+' + colWidths.map(w => '-'.repeat(w + 2)).join('+') + '+';
    const lines: string[] = [separator];

    tableData.forEach((row, rowIdx) => {
      const paddedRow = row.map((cell, idx) => ` ${padCell(cell, colWidths[idx])} `);
      // fill missing columns if any
      while (paddedRow.length < colCount) {
        paddedRow.push(` ${' '.repeat(colWidths[paddedRow.length])} `);
      }
      lines.push('|' + paddedRow.join('|') + '|');
      if (rowIdx === 0 && tableData.length > 1) {
        lines.push(separator); // header divider
      }
    });
    lines.push(separator);
    return lines.join('\n');
  }

  // Default: Standard Markdown pipe table
  const colCount = Math.max(...tableData.map(r => r.length), 0);
  const lines: string[] = [];
  tableData.forEach((row, rowIdx) => {
    lines.push('| ' + row.join(' | ') + ' |');
    if (rowIdx === 0) {
      lines.push('| ' + Array(colCount).fill('---').join(' | ') + ' |');
    }
  });
  return lines.join('\n');
}

/**
 * Convert structured Block array into customized Plain Text
 */
export function convertBlocksToPlainText(blocks: Block[], rules: MdToTextRules): string {
  const resultLines: string[] = [];
  const headingCounters = [0, 0, 0, 0, 0, 0]; // For H1 .. H6 hierarchical numbering
  let currentListCounter = 1;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];

    // Handle code blocks
    if (b.type === 'code') {
      let codeText = b.html
        .replace(/\r?\n/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\u00A0/g, ' ')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '');

      if (rules.headingStyle === 'markdown') {
        resultLines.push(`\`\`\`\n${codeText}\n\`\`\``);
      } else {
        // Plain text code representation
        resultLines.push(`--- [Code / Script] ---\n${codeText}\n-----------------------`);
      }
      continue;
    }

    // Handle horizontal dividers
    if (b.type === 'divider') {
      resultLines.push('--------------------------------------------------');
      continue;
    }

    // Handle tables
    if (b.type === 'table') {
      resultLines.push(formatTableBlock(b.html, rules));
      continue;
    }

    // Extract text content
    let rawText = '';
    if (b.isRaw) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = b.html
        .replace(/\r?\n/g, '')
        .replace(/<br\s*\/?>/gi, '\n');
      rawText = tempDiv.textContent || tempDiv.innerText || '';
    } else {
      rawText = htmlToMarkdown(b.html);
    }
    const cleanContent = formatInlineText(rawText.trim(), rules);

    const indentSpaces = '  '.repeat(b.indent);

    // Headings (H1..H6)
    if (b.type.startsWith('h')) {
      const level = parseInt(b.type.substring(1), 10) || 1;
      
      // Update hierarchical numbering
      headingCounters[level - 1]++;
      for (let c = level; c < 6; c++) headingCounters[c] = 0; // reset sub-levels

      if (rules.headingStyle === 'numbered') {
        const numPrefix = headingCounters.slice(0, level).join('.') + '.';
        resultLines.push(`${indentSpaces}${numPrefix} ${cleanContent}`);
      } else if (rules.headingStyle === 'brackets') {
        if (level === 1) {
          resultLines.push(`\n${indentSpaces}【 ${cleanContent} 】`);
        } else if (level === 2) {
          resultLines.push(`${indentSpaces}[ ${cleanContent} ]`);
        } else if (level === 3) {
          resultLines.push(`${indentSpaces}■ ${cleanContent}`);
        } else if (level === 4) {
          resultLines.push(`${indentSpaces}▶ ${cleanContent}`);
        } else {
          resultLines.push(`${indentSpaces}· ${cleanContent}`);
        }
      } else if (rules.headingStyle === 'underline') {
        resultLines.push(`${indentSpaces}${cleanContent}`);
        const underlineChar = level === 1 ? '=' : '-';
        const underlineLen = Math.max(cleanContent.length, 12);
        resultLines.push(`${indentSpaces}${underlineChar.repeat(underlineLen)}`);
      } else if (rules.headingStyle === 'markdown') {
        const hashes = '#'.repeat(level);
        resultLines.push(`${indentSpaces}${hashes} ${cleanContent}`);
      } else {
        // Plain
        resultLines.push(`${indentSpaces}${cleanContent}`);
      }
      continue;
    }

    // Unordered & Ordered Lists
    if (b.type === 'list') {
      if (b.listType === 'ol') {
        let prefix = `${currentListCounter}. `;
        if (rules.orderedListStyle === 'paren') {
          prefix = `${currentListCounter}) `;
        } else if (rules.orderedListStyle === 'brackets') {
          prefix = `[${currentListCounter}] `;
        } else if (rules.orderedListStyle === 'circle_num') {
          prefix = (currentListCounter <= 20 ? CIRCLE_NUMBERS[currentListCounter - 1] : `${currentListCounter})`) + ' ';
        }
        resultLines.push(`${indentSpaces}${prefix}${cleanContent}`);
        currentListCounter++;
      } else {
        currentListCounter = 1; // reset ordered counter
        let bullet = '• ';
        if (rules.listStyle === 'middle_dot') bullet = '· ';
        else if (rules.listStyle === 'dash') bullet = '- ';
        else if (rules.listStyle === 'star') bullet = '* ';
        else if (rules.listStyle === 'indent') bullet = '';

        resultLines.push(`${indentSpaces}${bullet}${cleanContent}`);
      }
      continue;
    } else {
      currentListCounter = 1; // reset when leaving list
    }

    // Checkboxes / Tasks
    if (b.type === 'checkbox') {
      let mark = b.checked ? '■ ' : '□ ';
      if (rules.checkboxStyle === 'bracket_v') {
        mark = b.checked ? '[V] ' : '[ ] ';
      } else if (rules.checkboxStyle === 'unicode_circle') {
        mark = b.checked ? '● ' : '○ ';
      } else if (rules.checkboxStyle === 'markdown') {
        mark = b.checked ? '[x] ' : '[ ] ';
      }
      resultLines.push(`${indentSpaces}${mark}${cleanContent}`);
      continue;
    }

    // Blockquotes
    if (b.type === 'quote') {
      let qPrefix = '│ ';
      if (rules.quoteStyle === 'quotes') {
        resultLines.push(`${indentSpaces}"${cleanContent}"`);
        continue;
      } else if (rules.quoteStyle === 'markdown') {
        qPrefix = '> ';
      } else if (rules.quoteStyle === 'indent') {
        qPrefix = '    ';
      }
      resultLines.push(`${indentSpaces}${qPrefix}${cleanContent}`);
      continue;
    }

    // Standard Paragraph / Plain text
    resultLines.push(`${indentSpaces}${cleanContent}`);
  }

  let finalOutput = resultLines.join('\n');

  if (rules.cleanBlankLines) {
    // Compress 3+ consecutive newlines to 2
    finalOutput = finalOutput.replace(/\n{3,}/g, '\n\n');
  }

  return finalOutput;
}

/**
 * Convenient wrapper: Converts raw Markdown string into customized Plain Text
 */
export function convertMarkdownToPlainText(markdown: string, rules: MdToTextRules): string {
  const blocks = parseMarkdownToBlocks(markdown);
  return convertBlocksToPlainText(blocks, rules);
}

const LOCAL_STORAGE_RULES_KEY = 'mhz_md_to_text_rules_v1';

export function loadSavedRules(): MdToTextRules {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_RULES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...PRESET_RULES.business, ...parsed };
    }
  } catch (err) {
    console.error('Failed to load saved MD to Text rules:', err);
  }
  return PRESET_RULES.business;
}

export function saveRulesToStorage(rules: MdToTextRules): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_RULES_KEY, JSON.stringify(rules));
  } catch (err) {
    console.error('Failed to save MD to Text rules:', err);
  }
}

