import { Block, BlockType, generateId } from './markdownBlockUtils';

export type TargetBlockType =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'checkbox_checked'
  | 'checkbox_unchecked'
  | 'list_ul'
  | 'list_ol'
  | 'quote'
  | 'code'
  | 'divider'
  | 'paragraph';

export interface PatternRule {
  id: string;
  patternType: 'bracket' | 'prefix';
  patternLabel: string;
  prefix?: string;
  openPrefix?: string;
  closeSuffix?: string;
  targetType: TargetBlockType;
  count?: number;
  enabled: boolean;
  isBuiltIn?: boolean;
}

export const TARGET_LABELS: Record<TargetBlockType, string> = {
  h1: 'H1 헤더 (가장 큰 제목)',
  h2: 'H2 헤더 (소제목)',
  h3: 'H3 헤더 (중간 제목)',
  h4: 'H4 헤더 (소항목 제목)',
  h5: 'H5 헤더 (작은 제목)',
  h6: 'H6 헤더 (최소 제목)',
  checkbox_checked: '체크박스 [x] (완료 상태)',
  checkbox_unchecked: '체크박스 [ ] (미완료 상태)',
  list_ul: '글머리 기호 목록 (• / -)',
  list_ol: '순서 있는 목록 (1. / 1))',
  quote: '인용구 (│ / >)',
  code: '코드 블록 (Code Block)',
  divider: '구분선 (Divider ---)',
  paragraph: '일반 본문 텍스트 (Paragraph)',
};

export const DEFAULT_BUILTIN_RULES: PatternRule[] = [
  // Brackets for Headings
  { id: 'bracket_h1', patternType: 'bracket', patternLabel: '【 ... 】', openPrefix: '【', closeSuffix: '】', targetType: 'h1', enabled: true, isBuiltIn: true },
  { id: 'bracket_h2', patternType: 'bracket', patternLabel: '[ ... ]', openPrefix: '[', closeSuffix: ']', targetType: 'h2', enabled: true, isBuiltIn: true },
  
  // Prefixes for Headings
  { id: 'prefix_h3', patternType: 'prefix', patternLabel: '■ (공백 뒤 제목)', prefix: '■ ', targetType: 'h3', enabled: true, isBuiltIn: true },
  { id: 'prefix_h4', patternType: 'prefix', patternLabel: '▶ (공백 뒤 제목)', prefix: '▶ ', targetType: 'h4', enabled: true, isBuiltIn: true },

  // Checkboxes Checked
  { id: 'chk_done_black_sq', patternType: 'prefix', patternLabel: '■ (완료 체크박스)', prefix: '■ ', targetType: 'checkbox_checked', enabled: false, isBuiltIn: true },
  { id: 'chk_done_bracket_v', patternType: 'prefix', patternLabel: '[V] / [v]', prefix: '[V] ', targetType: 'checkbox_checked', enabled: true, isBuiltIn: true },
  { id: 'chk_done_bracket_x', patternType: 'prefix', patternLabel: '[x] / [X]', prefix: '[x] ', targetType: 'checkbox_checked', enabled: true, isBuiltIn: true },
  { id: 'chk_done_circle', patternType: 'prefix', patternLabel: '● (완료 원형)', prefix: '● ', targetType: 'checkbox_checked', enabled: true, isBuiltIn: true },

  // Checkboxes Unchecked
  { id: 'chk_undone_white_sq', patternType: 'prefix', patternLabel: '□ (미완료 체크박스)', prefix: '□ ', targetType: 'checkbox_unchecked', enabled: true, isBuiltIn: true },
  { id: 'chk_undone_bracket', patternType: 'prefix', patternLabel: '[ ] (공백 괄호)', prefix: '[ ] ', targetType: 'checkbox_unchecked', enabled: true, isBuiltIn: true },
  { id: 'chk_undone_circle', patternType: 'prefix', patternLabel: '○ (미완료 원형)', prefix: '○ ', targetType: 'checkbox_unchecked', enabled: true, isBuiltIn: true },

  // Lists
  { id: 'list_bullet', patternType: 'prefix', patternLabel: '• (불릿 점)', prefix: '• ', targetType: 'list_ul', enabled: true, isBuiltIn: true },
  { id: 'list_middle_dot', patternType: 'prefix', patternLabel: '· (중간점)', prefix: '· ', targetType: 'list_ul', enabled: true, isBuiltIn: true },
  { id: 'list_dash', patternType: 'prefix', patternLabel: '- (대시 목록)', prefix: '- ', targetType: 'list_ul', enabled: true, isBuiltIn: true },
  { id: 'list_star', patternType: 'prefix', patternLabel: '* (별표 목록)', prefix: '* ', targetType: 'list_ul', enabled: true, isBuiltIn: true },

  // Ordered Lists
  { id: 'list_ordered_paren', patternType: 'prefix', patternLabel: '1) / 2) (괄호 숫자)', prefix: '1) ', targetType: 'list_ol', enabled: true, isBuiltIn: true },
  { id: 'list_ordered_brackets', patternType: 'prefix', patternLabel: '[1] / [2] (대괄호 숫자)', prefix: '[1] ', targetType: 'list_ol', enabled: true, isBuiltIn: true },

  // Quotes
  { id: 'quote_bar', patternType: 'prefix', patternLabel: '│ (세로 실선)', prefix: '│ ', targetType: 'quote', enabled: true, isBuiltIn: true },
  { id: 'quote_pipe', patternType: 'prefix', patternLabel: '| (파이프 세로선)', prefix: '| ', targetType: 'quote', enabled: true, isBuiltIn: true },
  { id: 'quote_gt', patternType: 'prefix', patternLabel: '> (인용 부호)', prefix: '> ', targetType: 'quote', enabled: true, isBuiltIn: true },

  // Dividers
  { id: 'divider_line', patternType: 'prefix', patternLabel: '--- / ─── (구분선)', prefix: '---', targetType: 'divider', enabled: true, isBuiltIn: true },
];

const STORAGE_KEY_REVERSE_RULES = 'mhz_text_to_md_reverse_rules_v1';
const STORAGE_KEY_SHOW_MODAL = 'mhz_show_reverse_ingestion_modal';

export function loadStoredReverseRules(): PatternRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_REVERSE_RULES);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Merge with defaults to ensure all builtins exist
        const existingIds = new Set(parsed.map(r => r.id));
        const missingDefaults = DEFAULT_BUILTIN_RULES.filter(d => !existingIds.has(d.id));
        return [...parsed, ...missingDefaults];
      }
    }
  } catch (err) {
    console.error('Failed to load reverse rules:', err);
  }
  return DEFAULT_BUILTIN_RULES.map(r => ({ ...r }));
}

export function saveStoredReverseRules(rules: PatternRule[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_REVERSE_RULES, JSON.stringify(rules));
  } catch (err) {
    console.error('Failed to save reverse rules:', err);
  }
}

export function shouldShowIngestionModal(): boolean {
  try {
    const val = localStorage.getItem(STORAGE_KEY_SHOW_MODAL);
    return val !== 'false'; // default true
  } catch {
    return true;
  }
}

export function setShouldShowIngestionModal(show: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY_SHOW_MODAL, show ? 'true' : 'false');
  } catch {}
}

/**
 * Scan text line by line and count occurrences for each rule
 */
export function scanDocumentForPatterns(text: string, activeRules: PatternRule[]): PatternRule[] {
  if (!text) return activeRules.map(r => ({ ...r, count: 0 }));

  const lines = text.split(/\r?\n/);
  const counts: Record<string, number> = {};
  activeRules.forEach(r => { counts[r.id] = 0; });

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    for (const rule of activeRules) {
      if (rule.patternType === 'bracket' && rule.openPrefix && rule.closeSuffix) {
        if (line.startsWith(rule.openPrefix) && line.endsWith(rule.closeSuffix) && line.length > rule.openPrefix.length + rule.closeSuffix.length) {
          counts[rule.id]++;
          break; // Count first matching rule for this line
        }
      } else if (rule.patternType === 'prefix' && rule.prefix) {
        const cleanPrefix = rule.prefix.trim();
        // Check case insensitive for [v], [x]
        if (rule.id === 'chk_done_bracket_v' && /^\[[vV]\]\s/.test(line)) {
          counts[rule.id]++;
          break;
        } else if (rule.id === 'chk_done_bracket_x' && /^\[[xX]\]\s/.test(line)) {
          counts[rule.id]++;
          break;
        } else if (rule.id === 'list_ordered_paren' && /^\d+\)\s/.test(line)) {
          counts[rule.id]++;
          break;
        } else if (rule.id === 'list_ordered_brackets' && /^\[\d+\]\s/.test(line)) {
          counts[rule.id]++;
          break;
        } else if (rule.id === 'divider_line' && /^(-{3,}|_{3,}|\*{3,}|─{3,})/.test(line)) {
          counts[rule.id]++;
          break;
        } else if (line.startsWith(cleanPrefix)) {
          counts[rule.id]++;
          break;
        }
      }
    }
  }

  // Update counts on rules and sort: detected rules (count > 0) first, then by count descending
  return activeRules.map(r => ({
    ...r,
    count: counts[r.id] || 0,
  })).sort((a, b) => (b.count || 0) - (a.count || 0));
}

/**
 * Parses a plain text document into rich Block[] using user-defined PatternRules
 */
export function parseTextToBlocksWithRules(text: string, rules: PatternRule[]): Block[] {
  if (!text || !text.trim()) {
    return [{ id: generateId(), type: 'paragraph', html: '', indent: 0 }];
  }

  const enabledRules = rules.filter(r => r.enabled);
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Preserve blank lines
    if (!trimmed) {
      blocks.push({ id: generateId(), type: 'paragraph', html: '', indent: 0 });
      i++;
      continue;
    }

    // Code blocks
    if (trimmed.startsWith('```')) {
      let codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        id: generateId(),
        type: 'code',
        html: codeLines.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'),
        indent: 0,
      });
      if (i < lines.length) i++;
      continue;
    }

    // TSV or Table detection: if line contains multiple tabs (\t)
    if (rawLine.includes('\t') && rawLine.split('\t').length >= 2) {
      const tableRows: string[] = [];
      while (i < lines.length && lines[i].includes('\t')) {
        tableRows.push(lines[i]);
        i++;
      }
      if (tableRows.length > 0) {
        const tableHtml = generateHtmlTableFromTsv(tableRows);
        blocks.push({
          id: generateId(),
          type: 'table',
          html: tableHtml,
          indent: 0,
        });
        continue;
      }
    }

    // Standard markdown table detection
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      let tableMd = rawLine;
      let j = i + 1;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        tableMd += '\n' + lines[j];
        j++;
      }
      if (j > i + 1) {
        // Table found
        const tableHtml = generateHtmlTableFromMarkdown(tableMd);
        blocks.push({
          id: generateId(),
          type: 'table',
          html: tableHtml,
          indent: 0,
        });
        i = j;
        continue;
      }
    }

    // Check Setext underline headings: next line has === (or --- only if divider rule is disabled)
    if (i + 1 < lines.length) {
      const nextLine = lines[i + 1].trim();
      const hasDividerRule = rules.some(r => r.enabled && (r.targetType === 'divider' || r.prefix === '---'));
      if (/^={3,}$/.test(nextLine)) {
        blocks.push({ id: generateId(), type: 'h1', html: escapeHtml(trimmed), indent: 0 });
        i += 2;
        continue;
      } else if (!hasDividerRule && /^-{3,}$/.test(nextLine) && !trimmed.startsWith('-')) {
        blocks.push({ id: generateId(), type: 'h2', html: escapeHtml(trimmed), indent: 0 });
        i += 2;
        continue;
      }
    }

    // Standard markdown headings (# ~ ######)
    const mdHeading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (mdHeading) {
      const level = mdHeading[1].length;
      blocks.push({
        id: generateId(),
        type: `h${level}` as BlockType,
        html: escapeHtml(mdHeading[2].trim()),
        indent: 0,
      });
      i++;
      continue;
    }

    // Numbered hierarchical headings: e.g. "1. 제목" / "1.1. 소제목" / "1.1.1. 세부항목"
    const numHeadingMatch = trimmed.match(/^(\d+(\.\d+)*)\.?\s+(.+)$/);
    if (numHeadingMatch && !trimmed.startsWith('1)')) {
      const depth = numHeadingMatch[1].split('.').length;
      // If depth is 2 (e.g. 1.1) -> H2, depth 3 (1.1.1) -> H3, depth 1 followed by 1.1 -> H1
      if (depth === 2) {
        blocks.push({ id: generateId(), type: 'h2', html: escapeHtml(trimmed), indent: 0 });
        i++;
        continue;
      } else if (depth >= 3) {
        blocks.push({ id: generateId(), type: 'h3', html: escapeHtml(trimmed), indent: 0 });
        i++;
        continue;
      }
    }

    // Match against user defined PatternRules
    let matchedBlock: Block | null = null;

    // Detect indentation spaces (e.g. 2 spaces or 1 tab = indent 1)
    const leadingSpaces = rawLine.match(/^(\s*)/)?.[1] || '';
    const indentLevel = Math.min(Math.floor(leadingSpaces.length / 2), 6);

    for (const rule of enabledRules) {
      if (rule.patternType === 'bracket' && rule.openPrefix && rule.closeSuffix) {
        if (trimmed.startsWith(rule.openPrefix) && trimmed.endsWith(rule.closeSuffix) && trimmed.length > rule.openPrefix.length + rule.closeSuffix.length) {
          const innerContent = trimmed.substring(rule.openPrefix.length, trimmed.length - rule.closeSuffix.length).trim();
          matchedBlock = createBlockFromTargetType(rule.targetType, innerContent, indentLevel);
          break;
        }
      } else if (rule.patternType === 'prefix' && rule.prefix) {
        let isMatch = false;
        let contentAfter = '';

        if (rule.id === 'chk_done_bracket_v') {
          const m = trimmed.match(/^\[[vV]\]\s+(.*)$/);
          if (m) { isMatch = true; contentAfter = m[1]; }
        } else if (rule.id === 'chk_done_bracket_x') {
          const m = trimmed.match(/^\[[xX]\]\s+(.*)$/);
          if (m) { isMatch = true; contentAfter = m[1]; }
        } else if (rule.id === 'list_ordered_paren') {
          const m = trimmed.match(/^\d+\)\s+(.*)$/);
          if (m) { isMatch = true; contentAfter = m[1]; }
        } else if (rule.id === 'list_ordered_brackets') {
          const m = trimmed.match(/^\[\d+\]\s+(.*)$/);
          if (m) { isMatch = true; contentAfter = m[1]; }
        } else if (rule.id === 'divider_line') {
          if (/^(-{3,}|_{3,}|\*{3,}|─{3,})/.test(trimmed)) {
            isMatch = true;
            contentAfter = '';
          }
        } else if (trimmed.startsWith(rule.prefix.trim())) {
          isMatch = true;
          contentAfter = trimmed.substring(rule.prefix.trim().length).trim();
        }

        if (isMatch) {
          matchedBlock = createBlockFromTargetType(rule.targetType, contentAfter, indentLevel);
          break;
        }
      }
    }

    if (matchedBlock) {
      blocks.push(matchedBlock);
    } else {
      // Default fallback: regular paragraph
      blocks.push({
        id: generateId(),
        type: 'paragraph',
        html: escapeHtml(trimmed),
        indent: indentLevel,
      });
    }

    i++;
  }

  return blocks.length > 0 ? blocks : [{ id: generateId(), type: 'paragraph', html: '', indent: 0 }];
}

function createBlockFromTargetType(targetType: TargetBlockType, content: string, indent: number): Block {
  const html = escapeHtml(content);

  switch (targetType) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return { id: generateId(), type: targetType, html, indent: 0 };
    case 'checkbox_checked':
      return { id: generateId(), type: 'checkbox', html, checked: true, indent };
    case 'checkbox_unchecked':
      return { id: generateId(), type: 'checkbox', html, checked: false, indent };
    case 'list_ul':
      return { id: generateId(), type: 'list', html, listType: 'ul', indent };
    case 'list_ol':
      return { id: generateId(), type: 'list', html, listType: 'ol', indent };
    case 'quote':
      return { id: generateId(), type: 'quote', html, indent };
    case 'divider':
      return { id: generateId(), type: 'divider', html: '', indent: 0 };
    case 'code':
      return { id: generateId(), type: 'code', html: html.replace(/\n/g, '<br>'), indent: 0 };
    default:
      return { id: generateId(), type: 'paragraph', html, indent };
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function generateHtmlTableFromTsv(tsvLines: string[]): string {
  const rows = tsvLines.map(l => l.split('\t').map(c => escapeHtml(c.trim())));
  if (rows.length === 0) return '';

  let html = '<table>';
  rows.forEach((cols, rIdx) => {
    html += '<tr>';
    cols.forEach(cell => {
      const tag = rIdx === 0 ? 'th' : 'td';
      html += `<${tag}>${cell || '&nbsp;'}</${tag}>`;
    });
    html += '</tr>';
  });
  html += '</table>';
  return html;
}

function generateHtmlTableFromMarkdown(tableMd: string): string {
  const lines = tableMd.split('\n').filter(l => l.trim().startsWith('|'));
  let html = '<table>';
  let isFirstRow = true;

  for (const line of lines) {
    // Skip separator line |---|---|
    if (/^[|\s-:]+$/.test(line) && line.includes('-')) {
      continue;
    }
    const cells = line.split('|').slice(1, -1).map(c => escapeHtml(c.trim()));
    html += '<tr>';
    cells.forEach(c => {
      const tag = isFirstRow ? 'th' : 'td';
      html += `<${tag}>${c || '&nbsp;'}</${tag}>`;
    });
    html += '</tr>';
    isFirstRow = false;
  }
  html += '</table>';
  return html;
}

