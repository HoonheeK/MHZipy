import React, { useState, useMemo, useEffect } from 'react';
import {
  PatternRule,
  TargetBlockType,
  TARGET_LABELS,
  DEFAULT_BUILTIN_RULES,
  scanDocumentForPatterns,
  parseTextToBlocksWithRules,
  saveStoredReverseRules,
  setShouldShowIngestionModal,
} from './textToMdScanner';
import { Block, serializeBlocksToMarkdown } from './markdownBlockUtils';
import { X, Check, Plus, Trash2, RotateCcw, Eye, Sparkles } from 'lucide-react';

interface TextToMdIngestionModalProps {
  isOpen: boolean;
  onClose: () => void;
  documentText: string;
  initialRules: PatternRule[];
  onApplyIngestion: (blocks: Block[], updatedRules: PatternRule[]) => void;
}

export const TextToMdIngestionModal: React.FC<TextToMdIngestionModalProps> = ({
  isOpen,
  onClose,
  documentText,
  initialRules,
  onApplyIngestion,
}) => {
  const [rules, setRules] = useState<PatternRule[]>([]);
  const [saveAsDefault, setSaveAsDefault] = useState<boolean>(true);
  const [dontAskAgain, setDontAskAgain] = useState<boolean>(false);

  // New Custom Pattern State
  const [newPatternType, setNewPatternType] = useState<'prefix' | 'bracket'>('prefix');
  const [newPrefix, setNewPrefix] = useState<string>('');
  const [newOpenBracket, setNewOpenBracket] = useState<string>('【');
  const [newCloseBracket, setNewCloseBracket] = useState<string>('】');
  const [newTargetType, setNewTargetType] = useState<TargetBlockType>('h3');

  // Synchronize and scan whenever modal opens
  useEffect(() => {
    if (isOpen) {
      const scanned = scanDocumentForPatterns(documentText, initialRules);
      setRules(scanned);
    }
  }, [isOpen, documentText, initialRules]);

  // Live real-time converted preview
  const livePreviewMarkdown = useMemo(() => {
    if (!isOpen || !documentText) return '';
    try {
      // Take first 50 lines for speedy live preview
      const previewSlice = documentText.split('\n').slice(0, 45).join('\n');
      const blocks = parseTextToBlocksWithRules(previewSlice, rules);
      return serializeBlocksToMarkdown(blocks);
    } catch {
      return '';
    }
  }, [documentText, rules, isOpen]);

  if (!isOpen) return null;

  // Toggle rule enabled/disabled
  const handleToggleRule = (id: string, enabled: boolean) => {
    setRules(prev => prev.map(r => r.id === id ? { ...r, enabled } : r));
  };

  // Change rule target type
  const handleChangeTargetType = (id: string, targetType: TargetBlockType) => {
    setRules(prev => prev.map(r => r.id === id ? { ...r, targetType } : r));
  };

  // Delete a rule
  const handleDeleteRule = (id: string) => {
    setRules(prev => prev.filter(r => r.id !== id));
  };

  // Add new custom pattern
  const handleAddPattern = () => {
    if (newPatternType === 'prefix' && !newPrefix.trim()) return;
    if (newPatternType === 'bracket' && (!newOpenBracket.trim() || !newCloseBracket.trim())) return;

    const newRule: PatternRule = newPatternType === 'prefix'
      ? {
          id: `custom_${Date.now()}`,
          patternType: 'prefix',
          patternLabel: `${newPrefix} (사용자 정의)`,
          prefix: newPrefix.endsWith(' ') ? newPrefix : `${newPrefix} `,
          targetType: newTargetType,
          enabled: true,
          isBuiltIn: false,
        }
      : {
          id: `custom_${Date.now()}`,
          patternType: 'bracket',
          patternLabel: `${newOpenBracket} ... ${newCloseBracket} (사용자 정의)`,
          openPrefix: newOpenBracket,
          closeSuffix: newCloseBracket,
          targetType: newTargetType,
          enabled: true,
          isBuiltIn: false,
        };

    const updated = [newRule, ...rules];
    const scanned = scanDocumentForPatterns(documentText, updated);
    setRules(scanned);
    setNewPrefix('');
  };

  // Reset to default
  const handleResetDefaults = () => {
    const scanned = scanDocumentForPatterns(documentText, DEFAULT_BUILTIN_RULES);
    setRules(scanned);
  };

  // Apply and convert
  const handleApply = () => {
    if (saveAsDefault) {
      saveStoredReverseRules(rules);
    }
    if (dontAskAgain) {
      setShouldShowIngestionModal(false);
    }

    const finalBlocks = parseTextToBlocksWithRules(documentText, rules);
    onApplyIngestion(finalBlocks, rules);
    onClose();
  };

  const detectedCount = rules.filter(r => (r.count || 0) > 0).length;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(11, 17, 32, 0.78)',
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
          width: '940px',
          maxWidth: '95vw',
          maxHeight: '90vh',
          backgroundColor: '#0f172a',
          border: '1px solid rgba(148, 163, 184, 0.25)',
          borderRadius: '12px',
          boxShadow: '0 25px 60px rgba(0, 0, 0, 0.75)',
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
            <Sparkles size={20} color="#38bdf8" />
            <div>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                Text ➔ Markdown 역파싱 규칙 검토 (Smart Ingestion)
              </h3>
              <span style={{ fontSize: '12px', color: '#94a3b8' }}>
                현재 텍스트 파일에서 감지된 패턴을 확인하고 마크다운 블록 매핑을 자유롭게 조정합니다.
              </span>
            </div>
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

        {/* Status Bar Indicator */}
        <div
          style={{
            padding: '8px 20px',
            backgroundColor: '#131e33',
            borderBottom: '1px solid rgba(148, 163, 184, 0.12)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#38bdf8' }}>
            <span>🔍 문서 내 총 <strong>{detectedCount}개</strong>의 서식 패턴이 발견되었습니다.</span>
          </div>
          <span style={{ color: '#94a3b8' }}>발견된 패턴이 상단에 우선 정렬됩니다.</span>
        </div>

        {/* Content Body (Dual-Column: Rules Table Left, Live Preview Right) */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Rules Table Left Column */}
          <div
            style={{
              flex: '1 1 58%',
              padding: '16px 20px',
              overflowY: 'auto',
              borderRight: '1px solid rgba(148, 163, 184, 0.15)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            {/* Pattern Rules List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0', marginBottom: '2px' }}>
                감지된 기호 및 변환 대상 블록 매핑
              </span>

              {rules.map((rule) => {
                const count = rule.count || 0;
                const isDetected = count > 0;

                return (
                  <div
                    key={rule.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '8px 12px',
                      backgroundColor: isDetected ? 'rgba(56, 189, 248, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                      border: isDetected ? '1px solid rgba(56, 189, 248, 0.3)' : '1px solid rgba(148, 163, 184, 0.1)',
                      borderRadius: '8px',
                      opacity: rule.enabled ? 1 : 0.45,
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {/* Enable Checkbox */}
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => handleToggleRule(rule.id, e.target.checked)}
                      title="이 규칙 활성화/비활성화"
                      style={{ accentColor: '#38bdf8', cursor: 'pointer' }}
                    />

                    {/* Pattern Badge */}
                    <div style={{ minWidth: '130px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span
                        style={{
                          fontFamily: '"JetBrains Mono", Consolas, monospace',
                          fontSize: '12px',
                          fontWeight: 600,
                          backgroundColor: '#1e293b',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          border: '1px solid rgba(148, 163, 184, 0.2)',
                          color: isDetected ? '#38bdf8' : '#cbd5e1',
                        }}
                      >
                        {rule.patternLabel}
                      </span>
                      {isDetected && (
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            color: '#22c55e',
                            backgroundColor: 'rgba(34, 197, 94, 0.15)',
                            padding: '1px 6px',
                            borderRadius: '10px',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {count}개
                        </span>
                      )}
                    </div>

                    <span style={{ color: '#64748b', fontSize: '12px' }}>➔</span>

                    {/* Target Block Type Dropdown */}
                    <select
                      value={rule.targetType}
                      disabled={!rule.enabled}
                      onChange={(e) => handleChangeTargetType(rule.id, e.target.value as TargetBlockType)}
                      style={{
                        flex: 1,
                        padding: '6px 8px',
                        backgroundColor: '#1e293b',
                        color: '#f8fafc',
                        border: '1px solid rgba(148, 163, 184, 0.25)',
                        borderRadius: '6px',
                        fontSize: '12px',
                        outline: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      {Object.entries(TARGET_LABELS).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>

                    {/* Delete button (only if not built-in or if disabled) */}
                    {!rule.isBuiltIn ? (
                      <button
                        onClick={() => handleDeleteRule(rule.id)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#ef4444',
                          cursor: 'pointer',
                          padding: '4px',
                        }}
                        title="규칙 삭제"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : (
                      <div style={{ width: '22px' }} />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Add Custom Pattern Form */}
            <div
              style={{
                marginTop: '10px',
                padding: '12px 14px',
                backgroundColor: 'rgba(255, 255, 255, 0.03)',
                border: '1px dashed rgba(148, 163, 184, 0.25)',
                borderRadius: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#38bdf8' }}>
                  + 새 감지 패턴 추가 (Custom Pattern)
                </span>
                <div style={{ display: 'flex', gap: '10px', fontSize: '11px', color: '#cbd5e1' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="pat_type"
                      checked={newPatternType === 'prefix'}
                      onChange={() => setNewPatternType('prefix')}
                    />
                    시작 기호 (Prefix)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="pat_type"
                      checked={newPatternType === 'bracket'}
                      onChange={() => setNewPatternType('bracket')}
                    />
                    감싸는 괄호 (Bracket)
                  </label>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {newPatternType === 'prefix' ? (
                  <input
                    type="text"
                    value={newPrefix}
                    onChange={(e) => setNewPrefix(e.target.value)}
                    placeholder="예: ▶ , ★ , Q. , (V) "
                    style={{
                      width: '140px',
                      padding: '5px 8px',
                      backgroundColor: '#1e293b',
                      color: '#ffffff',
                      border: '1px solid rgba(148, 163, 184, 0.25)',
                      borderRadius: '5px',
                      fontSize: '12px',
                      outline: 'none',
                    }}
                  />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <input
                      type="text"
                      value={newOpenBracket}
                      onChange={(e) => setNewOpenBracket(e.target.value)}
                      placeholder="앞 괄호"
                      style={{
                        width: '55px',
                        padding: '5px 6px',
                        backgroundColor: '#1e293b',
                        color: '#ffffff',
                        border: '1px solid rgba(148, 163, 184, 0.25)',
                        borderRadius: '5px',
                        fontSize: '12px',
                        textAlign: 'center',
                        outline: 'none',
                      }}
                    />
                    <span style={{ color: '#94a3b8', fontSize: '11px' }}>...</span>
                    <input
                      type="text"
                      value={newCloseBracket}
                      onChange={(e) => setNewCloseBracket(e.target.value)}
                      placeholder="뒤 괄호"
                      style={{
                        width: '55px',
                        padding: '5px 6px',
                        backgroundColor: '#1e293b',
                        color: '#ffffff',
                        border: '1px solid rgba(148, 163, 184, 0.25)',
                        borderRadius: '5px',
                        fontSize: '12px',
                        textAlign: 'center',
                        outline: 'none',
                      }}
                    />
                  </div>
                )}

                <span style={{ color: '#64748b', fontSize: '12px' }}>➔</span>

                <select
                  value={newTargetType}
                  onChange={(e) => setNewTargetType(e.target.value as TargetBlockType)}
                  style={{
                    flex: 1,
                    padding: '5px 8px',
                    backgroundColor: '#1e293b',
                    color: '#f8fafc',
                    border: '1px solid rgba(148, 163, 184, 0.25)',
                    borderRadius: '5px',
                    fontSize: '12px',
                    outline: 'none',
                  }}
                >
                  {Object.entries(TARGET_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={handleAddPattern}
                  style={{
                    padding: '5px 12px',
                    backgroundColor: '#0284c7',
                    color: '#ffffff',
                    border: '1px solid #38bdf8',
                    borderRadius: '5px',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  <Plus size={14} /> 추가
                </button>
              </div>
            </div>
          </div>

          {/* Live Preview Right Column */}
          <div
            style={{
              flex: '1 1 42%',
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
              <Eye size={14} />
              <span>실시간 변환 결과 미리보기 (Live Converted Preview)</span>
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
              {livePreviewMarkdown || '// 변환 결과가 여기에 표시됩니다.'}
            </pre>
          </div>
        </div>

        {/* Footer */}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#cbd5e1', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={saveAsDefault}
                onChange={(e) => setSaveAsDefault(e.target.checked)}
                style={{ accentColor: '#38bdf8' }}
              />
              이 설정을 기본 역파싱 규칙으로 저장
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#cbd5e1', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
                style={{ accentColor: '#38bdf8' }}
              />
              다음부터 다이얼로그 없이 바로 자동 변환
            </label>
            <button
              type="button"
              onClick={handleResetDefaults}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#94a3b8',
                fontSize: '12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <RotateCcw size={13} /> 기본값 초기화
            </button>
          </div>

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
              onClick={handleApply}
              style={{
                padding: '7px 20px',
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
              <Check size={16} /> 변환 실행 (Convert & Open MD)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

