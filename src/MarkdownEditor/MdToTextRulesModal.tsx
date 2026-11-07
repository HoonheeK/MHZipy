import React, { useState, useMemo, useEffect } from 'react';
import {
  MdToTextRules,
  PRESET_RULES,
  HeadingStyle,
  CheckboxStyle,
  ListStyle,
  OrderedListStyle,
  QuoteStyle,
  TableStyle,
  InlineStyle,
  convertMarkdownToPlainText,
  saveRulesToStorage,
} from './mdToTextConverter';
import { X, Check, Sliders, RotateCcw } from 'lucide-react';

interface MdToTextRulesModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentRules: MdToTextRules;
  onApplyRules: (rules: MdToTextRules) => void;
}

const SAMPLE_MARKDOWN = `# 프로젝트 진행 보고서
## 1. 개요 및 목표
본 문서는 **MHZipy** 파일 관리자의 *핵심 마일스톤* 현황입니다. 자세한 내용은 [공식 문서](https://github.com)를 참조하십시오.

## 2. 체크리스트 현황
- [x] 고성능 MFT 볼륨 인덱싱 구현
- [x] 다이얼로그 및 뷰어 윈도우 분리
- [ ] 클라우드 Web Folder 자동 동기화 기능 점검

## 3. 부서별 요청 사항
1. 파일 목록 빠른 검색 및 필터 속도 개선
2. 마크다운과 플레인 텍스트 간 양방향 변환 규칙 지원
3. 다크 테마 가독성 유지

> 참고: 다음 주 화요일 오전 10시에 정기 코드 리뷰가 예정되어 있습니다.

| 기능명 | 진행률 | 담당자 |
| 텍스트 에디터 | 95% | 개발팀 |
| PS 스튜디오 | 90% | 코어팀 |
`;

export const MdToTextRulesModal: React.FC<MdToTextRulesModalProps> = ({
  isOpen,
  onClose,
  currentRules,
  onApplyRules,
}) => {
  const [rules, setRules] = useState<MdToTextRules>(() => ({ ...currentRules }));

  // Synchronize rules whenever modal opens
  useEffect(() => {
    if (isOpen) {
      setRules({ ...currentRules });
    }
  }, [isOpen, currentRules]);

  const previewText = useMemo(() => {
    if (!isOpen) return '';
    return convertMarkdownToPlainText(SAMPLE_MARKDOWN, rules);
  }, [rules, isOpen]);

  const handlePresetSelect = (presetKey: string) => {
    if (PRESET_RULES[presetKey]) {
      setRules({ ...PRESET_RULES[presetKey] });
    }
  };

  const updateRule = <K extends keyof MdToTextRules>(key: K, value: MdToTextRules[K]) => {
    setRules(prev => ({ ...prev, [key]: value, id: 'custom', name: '사용자 정의 규칙 (Custom)' }));
  };

  const handleSaveAndApply = () => {
    saveRulesToStorage(rules);
    onApplyRules(rules);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(11, 17, 32, 0.75)',
        backdropFilter: 'blur(5px)',
        zIndex: 999999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '880px',
          maxWidth: '94vw',
          maxHeight: '90vh',
          backgroundColor: '#0f172a',
          border: '1px solid rgba(148, 163, 184, 0.25)',
          borderRadius: '12px',
          boxShadow: '0 25px 60px rgba(0, 0, 0, 0.7)',
          display: 'flex',
          flexDirection: 'column',
          color: '#f8fafc',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid rgba(148, 163, 184, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'linear-gradient(180deg, #1e293b 0%, #0f172a 100%)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Sliders size={20} color="#38bdf8" />
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
              Markdown → Plain Text 변환 규칙 정의 (Formatting Rules)
            </h3>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '4px',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Preset Selector Bar */}
        <div
          style={{
            padding: '12px 20px',
            backgroundColor: '#131e33',
            borderBottom: '1px solid rgba(148, 163, 184, 0.12)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '13px', color: '#94a3b8', marginRight: '4px' }}>간편 프리셋:</span>
          {Object.entries(PRESET_RULES).map(([key, p]) => {
            const isSelected = rules.id === p.id;
            return (
              <button
                key={key}
                onClick={() => handlePresetSelect(key)}
                style={{
                  padding: '5px 12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: isSelected ? 600 : 400,
                  cursor: 'pointer',
                  border: isSelected ? '1px solid #38bdf8' : '1px solid rgba(148, 163, 184, 0.2)',
                  backgroundColor: isSelected ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                  color: isSelected ? '#38bdf8' : '#cbd5e1',
                  transition: 'all 0.15s ease',
                }}
              >
                {p.name.split('(')[0].trim()}
              </button>
            );
          })}
        </div>

        {/* Content Body: Dual Column (Settings Left, Live Preview Right) */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Settings Left Column */}
          <div
            style={{
              flex: '1 1 55%',
              padding: '18px 20px',
              overflowY: 'auto',
              borderRight: '1px solid rgba(148, 163, 184, 0.15)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            {/* 1. Heading Style */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                1. 제목 / 헤더 (Headings H1 ~ H6)
              </label>
              <select
                value={rules.headingStyle}
                onChange={(e) => updateRule('headingStyle', e.target.value as HeadingStyle)}
                style={{
                  padding: '7px 10px',
                  backgroundColor: '#1e293b',
                  color: '#f8fafc',
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  borderRadius: '6px',
                  fontSize: '13px',
                  outline: 'none',
                }}
              >
                <option value="brackets">【 H1 제목 】, [ H2 소제목 ], ■ H3 항목 (보고서형)</option>
                <option value="numbered">1. H1 제목, 1.1. H2 소제목 (체계적 계층 번호형)</option>
                <option value="underline">H1 제목 (=== 밑줄), H2 소제목 (--- 밑줄)</option>
                <option value="markdown"># H1, ## H2 (마크다운 원본 기호 유지)</option>
                <option value="plain">장식 없는 순수 텍스트</option>
              </select>
            </div>

            {/* 2. Checkbox Style */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                2. 체크박스 / 할 일 목록 (Checkboxes)
              </label>
              <select
                value={rules.checkboxStyle}
                onChange={(e) => updateRule('checkboxStyle', e.target.value as CheckboxStyle)}
                style={{
                  padding: '7px 10px',
                  backgroundColor: '#1e293b',
                  color: '#f8fafc',
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  borderRadius: '6px',
                  fontSize: '13px',
                  outline: 'none',
                }}
              >
                <option value="unicode_box">□ 미완료 / ■ 완료 (유니코드 사각 기호)</option>
                <option value="bracket_v">[ ] 미완료 / [V] 완료 (텍스트 체크표시)</option>
                <option value="unicode_circle">○ 미완료 / ● 완료 (유니코드 원형 기호)</option>
                <option value="markdown">[ ] 미완료 / [x] 완료 (마크다운 표준)</option>
              </select>
            </div>

            {/* 3. List Style */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                3. 글머리 기호 목록 (Unordered Lists)
              </label>
              <select
                value={rules.listStyle}
                onChange={(e) => updateRule('listStyle', e.target.value as ListStyle)}
                style={{
                  padding: '7px 10px',
                  backgroundColor: '#1e293b',
                  color: '#f8fafc',
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  borderRadius: '6px',
                  fontSize: '13px',
                  outline: 'none',
                }}
              >
                <option value="bullet">• 불릿 점 (• 항목)</option>
                <option value="middle_dot">· 중간점 (· 항목)</option>
                <option value="dash">- 하이픈 대시 (- 항목)</option>
                <option value="star">* 별표 (* 항목)</option>
                <option value="indent">기호 없이 공백 들여쓰기만 적용</option>
              </select>
            </div>

            {/* 4. Ordered List Style */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                4. 순서 있는 목록 (Ordered Lists)
              </label>
              <select
                value={rules.orderedListStyle}
                onChange={(e) => updateRule('orderedListStyle', e.target.value as OrderedListStyle)}
                style={{
                  padding: '7px 10px',
                  backgroundColor: '#1e293b',
                  color: '#f8fafc',
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  borderRadius: '6px',
                  fontSize: '13px',
                  outline: 'none',
                }}
              >
                <option value="paren">1) 괄호 번호 (1), 2), 3))</option>
                <option value="dot">1. 마침표 번호 (1., 2., 3.)</option>
                <option value="brackets">[1] 대괄호 번호 ([1], [2], [3])</option>
                <option value="circle_num">① 원문자 (①, ②, ③)</option>
              </select>
            </div>

            {/* 5. Quote Style */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                5. 인용구 (Blockquotes)
              </label>
              <select
                value={rules.quoteStyle}
                onChange={(e) => updateRule('quoteStyle', e.target.value as QuoteStyle)}
                style={{
                  padding: '7px 10px',
                  backgroundColor: '#1e293b',
                  color: '#f8fafc',
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  borderRadius: '6px',
                  fontSize: '13px',
                  outline: 'none',
                }}
              >
                <option value="bar">│ 수직 세로선 (│ 내용)</option>
                <option value="quotes">" " 큰따옴표 감싸기</option>
                <option value="markdown">&gt; 마크다운 인용 기호 유지</option>
                <option value="indent">4칸 공백 들여쓰기</option>
              </select>
            </div>

            {/* 6. Table Style */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                6. 표 (Tables)
              </label>
              <select
                value={rules.tableStyle}
                onChange={(e) => updateRule('tableStyle', e.target.value as TableStyle)}
                style={{
                  padding: '7px 10px',
                  backgroundColor: '#1e293b',
                  color: '#f8fafc',
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  borderRadius: '6px',
                  fontSize: '13px',
                  outline: 'none',
                }}
              >
                <option value="tsv">탭 구분 (TSV) - 엑셀 / 스프레드시트 붙여넣기 최적화</option>
                <option value="ascii">+---+ 정렬된 아스키 그리드 표</option>
                <option value="markdown">| 마크다운 파이프 표 유지</option>
              </select>
            </div>

            {/* 7. Inline Formatting & Links */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                7. 인라인 서식 (볼드/기울임/코드)
              </label>
              <select
                value={rules.inlineStyle}
                onChange={(e) => updateRule('inlineStyle', e.target.value as InlineStyle)}
                style={{
                  padding: '7px 10px',
                  backgroundColor: '#1e293b',
                  color: '#f8fafc',
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  borderRadius: '6px',
                  fontSize: '13px',
                  outline: 'none',
                }}
              >
                <option value="clean">순수 텍스트로 기호 제거 (**굵게** → 굵게)</option>
                <option value="bracket">대괄호 강조 (**중요** → [중요])</option>
                <option value="keep">마크다운 기호 그대로 유지 (**굵게**)</option>
              </select>
            </div>

            {/* Extra Toggles */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#cbd5e1', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={rules.includeLinkUrl}
                  onChange={(e) => updateRule('includeLinkUrl', e.target.checked)}
                  style={{ accentColor: '#38bdf8' }}
                />
                링크 변환 시 대상 URL 주소 표기 (예: [텍스트](url) → 텍스트 (url))
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#cbd5e1', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={rules.cleanBlankLines}
                  onChange={(e) => updateRule('cleanBlankLines', e.target.checked)}
                  style={{ accentColor: '#38bdf8' }}
                />
                연속된 빈 줄(3줄 이상) 2줄로 깔끔하게 정리
              </label>
            </div>
          </div>

          {/* Live Preview Right Column */}
          <div
            style={{
              flex: '1 1 45%',
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: '#0b1120',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '8px 16px',
                backgroundColor: '#0e1726',
                borderBottom: '1px solid rgba(148, 163, 184, 0.12)',
                fontSize: '12px',
                fontWeight: 600,
                color: '#38bdf8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span>실시간 변환 결과 미리보기 (Live Preview)</span>
            </div>
            <pre
              style={{
                flex: 1,
                margin: 0,
                padding: '14px 16px',
                fontSize: '12px',
                lineHeight: 1.6,
                fontFamily: '"JetBrains Mono", Consolas, monospace',
                color: '#e2e8f0',
                backgroundColor: '#090e1a',
                overflow: 'auto',
                whiteSpace: 'pre',
                userSelect: 'text',
              }}
            >
              {previewText}
            </pre>
          </div>
        </div>

        {/* Footer Buttons */}
        <div
          style={{
            padding: '12px 20px',
            backgroundColor: '#0f172a',
            borderTop: '1px solid rgba(148, 163, 184, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <button
            onClick={() => handlePresetSelect('business')}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              cursor: 'pointer',
            }}
          >
            <RotateCcw size={14} /> 기본값 초기화
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={onClose}
              style={{
                padding: '7px 16px',
                borderRadius: '6px',
                fontSize: '13px',
                cursor: 'pointer',
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                color: '#cbd5e1',
                border: '1px solid rgba(148, 163, 184, 0.2)',
              }}
            >
              취소 (Cancel)
            </button>
            <button
              onClick={handleSaveAndApply}
              style={{
                padding: '7px 18px',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                backgroundColor: '#0284c7',
                color: '#ffffff',
                border: '1px solid #38bdf8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                boxShadow: '0 2px 8px rgba(2, 132, 199, 0.4)',
              }}
            >
              <Check size={16} /> 규칙 저장 및 변환 실행 (Apply & Convert)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
