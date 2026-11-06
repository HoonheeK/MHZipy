import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

export interface QAGroupFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface QAItemNode {
  id: string;
  path: string;
  alias?: string;
  parentId: string | null;
}

interface VisibleQANode {
  id: string;
  kind: 'group' | 'item';
  name: string;
  path?: string;
  parentId: string | null;
  depth: number;
  group?: QAGroupFolder;
  item?: QAItemNode;
}

interface QuickAccessTreeProps {
  quickAccessPaths: string[];
  selectedPath: string;
  filterQuickAccess: boolean;
  onToggleFilterQuickAccess: (checked: boolean) => void;
  onSelectPath: (path: string) => void;
  onUpdateQuickAccessPaths: (paths: string[]) => void;
}

const STORAGE_KEY = 'mhz_qa_tree_v1';
const COLLAPSED_KEY = 'mhz_qa_section_collapsed';

export const QuickAccessTree: React.FC<QuickAccessTreeProps> = ({
  quickAccessPaths,
  selectedPath,
  filterQuickAccess,
  onToggleFilterQuickAccess,
  onSelectPath,
  onUpdateQuickAccessPaths,
}) => {
  const { t } = useTranslation();

  const [isSectionCollapsed, setIsSectionCollapsed] = useState<boolean>(() => {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  });

  const [groups, setGroups] = useState<QAGroupFolder[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.groups)) return parsed.groups;
      }
    } catch {}
    return [];
  });

  const [items, setItems] = useState<QAItemNode[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.items)) return parsed.items;
      }
    } catch {}
    return quickAccessPaths.map((p, idx) => ({
      id: `qa_item_${idx}_${Date.now()}`,
      path: p,
      parentId: null,
    }));
  });

  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.expandedGroupIds)) {
          return new Set(parsed.expandedGroupIds);
        }
      }
    } catch {}
    return new Set();
  });

  // Selection & Focus state
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [anchorItemId, setAnchorItemId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  // Clipboard (Ctrl+C / Ctrl+X / Ctrl+V)
  const [qaClipboard, setQaClipboard] = useState<{
    itemIds: string[];
    op: 'copy' | 'cut';
  } | null>(null);

  // Drag & Drop state
  const [dragOverGroupId, setDragOverGroupId] = useState<string | 'ROOT' | null>(null);

  // Inline Rename state
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const [renamingText, setRenamingText] = useState<string>('');

  // Context Menu state
  const [qaMenu, setQaMenu] = useState<{
    x: number;
    y: number;
    targetKind: 'group' | 'item' | 'root';
    targetId: string | null;
  } | null>(null);

  // Marquee range selection state
  const [marquee, setMarquee] = useState<{
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const nodeElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const persistTreeMeta = useCallback(
    (nextGroups: QAGroupFolder[], nextItems: QAItemNode[], nextExpanded: Set<string>) => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            groups: nextGroups,
            items: nextItems,
            expandedGroupIds: Array.from(nextExpanded),
          })
        );
      } catch {}
    },
    []
  );

  // Keep items synchronized when external quickAccessPaths changes (e.g. "Add to Quick Access" from FileList/FolderTree)
  useEffect(() => {
    setItems((prevItems) => {
      const existingPaths = new Set(prevItems.map((it) => it.path));
      const incomingSet = new Set(quickAccessPaths);

      let changed = false;
      // Remove items whose path was removed externally
      let next = prevItems.filter((it) => {
        if (!incomingSet.has(it.path)) {
          changed = true;
          return false;
        }
        return true;
      });

      // Add newly added paths into activeGroupId (or root)
      for (const p of quickAccessPaths) {
        if (!existingPaths.has(p)) {
          changed = true;
          next.push({
            id: `qa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            path: p,
            parentId: activeGroupId,
          });
        }
      }

      if (changed) {
        persistTreeMeta(groups, next, expandedGroupIds);
        return next;
      }
      return prevItems;
    });
  }, [quickAccessPaths]);

  // Close context menu on outside click
  useEffect(() => {
    if (!qaMenu) return;
    const close = () => setQaMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('mhz-close-context-menu', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('mhz-close-context-menu', close);
    };
  }, [qaMenu]);

  const toggleSectionCollapsed = () => {
    setIsSectionCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  // Build Flattened Visible Tree Nodes
  const visibleNodes = useMemo<VisibleQANode[]>(() => {
    const result: VisibleQANode[] = [];
    const validGroupIds = new Set(groups.map((g) => g.id));

    const traverse = (parentId: string | null, depth: number) => {
      const childGroups = groups
        .filter((g) => (g.parentId && validGroupIds.has(g.parentId) ? g.parentId : null) === parentId)
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const grp of childGroups) {
        result.push({
          id: grp.id,
          kind: 'group',
          name: grp.name,
          parentId,
          depth,
          group: grp,
        });
        if (expandedGroupIds.has(grp.id)) {
          traverse(grp.id, depth + 1);
        }
      }

      const childItems = items.filter(
        (it) => (it.parentId && validGroupIds.has(it.parentId) ? it.parentId : null) === parentId
      );
      for (const it of childItems) {
        const defaultName = it.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || it.path;
        result.push({
          id: it.id,
          kind: 'item',
          name: it.alias || defaultName,
          path: it.path,
          parentId,
          depth,
          item: it,
        });
      }
    };

    traverse(null, 0);
    return result;
  }, [groups, items, expandedGroupIds]);

  // Marquee Selection Mouse Move / Up
  useEffect(() => {
    if (!marquee) return;

    const handleMouseMove = (e: MouseEvent) => {
      const nextMarquee = { ...marquee, curX: e.clientX, curY: e.clientY };
      setMarquee(nextMarquee);

      const minX = Math.min(nextMarquee.startX, nextMarquee.curX);
      const maxX = Math.max(nextMarquee.startX, nextMarquee.curX);
      const minY = Math.min(nextMarquee.startY, nextMarquee.curY);
      const maxY = Math.max(nextMarquee.startY, nextMarquee.curY);

      const hitIds = new Set<string>();
      for (const node of visibleNodes) {
        if (node.kind !== 'item') continue;
        const el = nodeElementsRef.current.get(node.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.left <= maxX && r.right >= minX && r.top <= maxY && r.bottom >= minY) {
          hitIds.add(node.id);
        }
      }
      if (hitIds.size > 0) {
        setSelectedItemIds(hitIds);
      }
    };

    const handleMouseUp = () => {
      setMarquee(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [marquee, visibleNodes]);

  const syncPathsToConfig = (nextItems: QAItemNode[]) => {
    const uniquePaths = Array.from(new Set(nextItems.map((it) => it.path)));
    onUpdateQuickAccessPaths(uniquePaths);
  };

  const handleCreateGroup = (parentId: string | null = null) => {
    if (isSectionCollapsed) {
      setIsSectionCollapsed(false);
      try {
        localStorage.setItem(COLLAPSED_KEY, '0');
      } catch {}
    }
    const newGroup: QAGroupFolder = {
      id: `qa_grp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: 'New Folder',
      parentId,
    };
    const nextGroups = [...groups, newGroup];
    const nextExpanded = new Set(expandedGroupIds);
    nextExpanded.add(newGroup.id);
    if (parentId) nextExpanded.add(parentId);

    setGroups(nextGroups);
    setExpandedGroupIds(nextExpanded);
    setActiveGroupId(newGroup.id);
    setFocusedNodeId(newGroup.id);
    setRenamingNodeId(newGroup.id);
    setRenamingText(newGroup.name);
    persistTreeMeta(nextGroups, items, nextExpanded);
  };

  const handleCopyItems = useCallback(() => {
    const ids = Array.from(selectedItemIds);
    if (ids.length === 0) return;
    setQaClipboard({ itemIds: ids, op: 'copy' });
  }, [selectedItemIds]);

  const handleCutItems = useCallback(() => {
    const ids = Array.from(selectedItemIds);
    if (ids.length === 0) return;
    setQaClipboard({ itemIds: ids, op: 'cut' });
  }, [selectedItemIds]);

  const handlePasteItems = useCallback(
    (targetGroupId: string | null) => {
      if (!qaClipboard || qaClipboard.itemIds.length === 0) return;

      if (qaClipboard.op === 'cut') {
        const cutSet = new Set(qaClipboard.itemIds);
        const nextItems = items.map((it) =>
          cutSet.has(it.id) ? { ...it, parentId: targetGroupId } : it
        );
        const nextExpanded = new Set(expandedGroupIds);
        if (targetGroupId) nextExpanded.add(targetGroupId);
        setItems(nextItems);
        setExpandedGroupIds(nextExpanded);
        setQaClipboard(null);
        persistTreeMeta(groups, nextItems, nextExpanded);
      } else {
        const sources = items.filter((it) => qaClipboard.itemIds.includes(it.id));
        if (sources.length === 0) return;
        const now = Date.now();
        const clones: QAItemNode[] = sources.map((src, idx) => ({
          ...src,
          id: `qa_${now}_${idx}_${Math.random().toString(36).slice(2, 5)}`,
          parentId: targetGroupId,
        }));
        const nextItems = [...items, ...clones];
        const nextExpanded = new Set(expandedGroupIds);
        if (targetGroupId) nextExpanded.add(targetGroupId);
        setItems(nextItems);
        setExpandedGroupIds(nextExpanded);
        setSelectedItemIds(new Set(clones.map((c) => c.id)));
        persistTreeMeta(groups, nextItems, nextExpanded);
      }
    },
    [qaClipboard, items, groups, expandedGroupIds, persistTreeMeta]
  );

  const handleDeleteNodes = useCallback(
    (targetKind?: 'group' | 'item', explicitId?: string) => {
      if (targetKind === 'group' && explicitId) {
        const delGroups = new Set<string>([explicitId]);
        let added = true;
        while (added) {
          added = false;
          for (const g of groups) {
            if (g.parentId && delGroups.has(g.parentId) && !delGroups.has(g.id)) {
              delGroups.add(g.id);
              added = true;
            }
          }
        }
        const nextGroups = groups.filter((g) => !delGroups.has(g.id));
        // Move items inside deleted group to root so user doesn't accidentally lose all bookmarks, or delete if explicit
        const nextItems = items.filter((it) => !it.parentId || !delGroups.has(it.parentId));
        setGroups(nextGroups);
        setItems(nextItems);
        persistTreeMeta(nextGroups, nextItems, expandedGroupIds);
        syncPathsToConfig(nextItems);
        return;
      }

      const idsToDelete =
        explicitId && !selectedItemIds.has(explicitId)
          ? new Set([explicitId])
          : new Set(selectedItemIds);
      if (idsToDelete.size === 0) return;

      const nextItems = items.filter((it) => !idsToDelete.has(it.id));
      setItems(nextItems);
      setSelectedItemIds(new Set());
      persistTreeMeta(groups, nextItems, expandedGroupIds);
      syncPathsToConfig(nextItems);
    },
    [groups, items, selectedItemIds, expandedGroupIds, persistTreeMeta]
  );

  const handleStartRename = (nodeId: string, currentName: string) => {
    setRenamingNodeId(nodeId);
    setRenamingText(currentName);
  };

  const handleFinishRename = () => {
    if (!renamingNodeId) return;
    const clean = renamingText.trim();
    if (!clean) {
      setRenamingNodeId(null);
      return;
    }

    if (groups.some((g) => g.id === renamingNodeId)) {
      const nextGroups = groups.map((g) => (g.id === renamingNodeId ? { ...g, name: clean } : g));
      setGroups(nextGroups);
      persistTreeMeta(nextGroups, items, expandedGroupIds);
    } else {
      const nextItems = items.map((it) => (it.id === renamingNodeId ? { ...it, alias: clean } : it));
      setItems(nextItems);
      persistTreeMeta(groups, nextItems, expandedGroupIds);
    }
    setRenamingNodeId(null);
  };

  const handleNodeClick = (e: React.MouseEvent, node: VisibleQANode) => {
    e.stopPropagation();
    containerRef.current?.focus();

    if (node.kind === 'group') {
      setActiveGroupId(node.id);
      setFocusedNodeId(node.id);
      setExpandedGroupIds((prev) => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        persistTreeMeta(groups, items, next);
        return next;
      });
      return;
    }

    const item = node.item!;
    setActiveGroupId(item.parentId ?? null);
    setFocusedNodeId(item.id);
    onSelectPath(item.path);

    if (e.shiftKey && anchorItemId) {
      const itemNodes = visibleNodes.filter((v) => v.kind === 'item');
      const aIdx = itemNodes.findIndex((v) => v.id === anchorItemId);
      const tIdx = itemNodes.findIndex((v) => v.id === item.id);
      if (aIdx !== -1 && tIdx !== -1) {
        const start = Math.min(aIdx, tIdx);
        const end = Math.max(aIdx, tIdx);
        const range = new Set<string>();
        for (let i = start; i <= end; i++) {
          range.add(itemNodes[i].id);
        }
        setSelectedItemIds(range);
        return;
      }
    }

    if (e.ctrlKey || e.metaKey) {
      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
      setAnchorItemId(item.id);
      return;
    }

    setSelectedItemIds(new Set([item.id]));
    setAnchorItemId(item.id);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (renamingNodeId) return;
    e.stopPropagation();

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      handleCopyItems();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      handleCutItems();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      handlePasteItems(activeGroupId);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      handleCreateGroup(activeGroupId);
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      const focused = visibleNodes.find((v) => v.id === focusedNodeId);
      if (focused?.kind === 'group') {
        handleDeleteNodes('group', focused.id);
      } else {
        handleDeleteNodes('item');
      }
      return;
    }
    if (e.key === 'F2' && focusedNodeId) {
      e.preventDefault();
      const focused = visibleNodes.find((v) => v.id === focusedNodeId);
      if (focused) {
        handleStartRename(focused.id, focused.name);
      }
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const itemNodes = visibleNodes.filter((v) => v.kind === 'item');
      if (itemNodes.length === 0) return;

      const curIdx = itemNodes.findIndex((v) => v.id === focusedNodeId);
      const nextIdx =
        e.key === 'ArrowDown'
          ? Math.min(itemNodes.length - 1, curIdx + 1)
          : Math.max(0, curIdx - 1);

      const nextNode = itemNodes[nextIdx];
      if (!nextNode || !nextNode.item) return;

      setFocusedNodeId(nextNode.id);
      onSelectPath(nextNode.item.path);

      const el = nodeElementsRef.current.get(nextNode.id);
      el?.scrollIntoView({ block: 'nearest' });

      if (e.shiftKey) {
        const effAnchor = anchorItemId || itemNodes[Math.max(0, curIdx)]?.id || nextNode.id;
        if (!anchorItemId) setAnchorItemId(effAnchor);
        const aIdx = itemNodes.findIndex((v) => v.id === effAnchor);
        if (aIdx !== -1) {
          const start = Math.min(aIdx, nextIdx);
          const end = Math.max(aIdx, nextIdx);
          const range = new Set<string>();
          for (let i = start; i <= end; i++) {
            range.add(itemNodes[i].id);
          }
          setSelectedItemIds(range);
        }
      } else {
        setSelectedItemIds(new Set([nextNode.id]));
        setAnchorItemId(nextNode.id);
      }
    }
  };

  const handleDragStart = (e: React.DragEvent, item: QAItemNode) => {
    let dragIds = Array.from(selectedItemIds);
    if (!selectedItemIds.has(item.id)) {
      dragIds = [item.id];
      setSelectedItemIds(new Set([item.id]));
      setAnchorItemId(item.id);
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-mhz-qa-items', JSON.stringify(dragIds));
  };

  const handleDropOnGroup = (e: React.DragEvent, targetGroupId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverGroupId(null);

    const raw = e.dataTransfer.getData('application/x-mhz-qa-items');
    if (!raw) return;
    try {
      const dragIds: string[] = JSON.parse(raw);
      if (!Array.isArray(dragIds) || dragIds.length === 0) return;
      const dragSet = new Set(dragIds);
      const nextItems = items.map((it) =>
        dragSet.has(it.id) ? { ...it, parentId: targetGroupId } : it
      );
      const nextExpanded = new Set(expandedGroupIds);
      if (targetGroupId) nextExpanded.add(targetGroupId);
      setItems(nextItems);
      setExpandedGroupIds(nextExpanded);
      setActiveGroupId(targetGroupId);
      persistTreeMeta(groups, nextItems, nextExpanded);
    } catch {}
  };

  return (
    <div style={{ marginBottom: '4px' }}>
      {/* Quick Access Header */}
      <div className="quick-access-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden' }}>
          <span>📌</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t('explorer.quickAccess', { defaultValue: 'Quick Access' })}
          </span>
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              fontWeight: 'normal',
              color: 'var(--mhz-text-dim)',
              fontSize: '0.74rem',
            }}
            title="Show only Quick Access folders in tree"
          >
            <input
              type="checkbox"
              checked={filterQuickAccess}
              onChange={(e) => onToggleFilterQuickAccess(e.target.checked)}
              style={{ marginRight: '3px' }}
              tabIndex={-1}
            />
            <span>{t('explorer.filterTree', { defaultValue: 'Filter' })}</span>
          </label>

          <button
            type="button"
            onClick={() => handleCreateGroup(null)}
            title="Create New Classification Folder in Quick Access (Ctrl+Shift+N)"
            style={{
              background: 'rgba(56, 189, 248, 0.14)',
              border: '1px solid rgba(56, 189, 248, 0.35)',
              color: '#38bdf8',
              borderRadius: '4px',
              padding: '1px 5px',
              fontSize: '0.72rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            + Folder
          </button>

          <button
            type="button"
            onClick={toggleSectionCollapsed}
            title={isSectionCollapsed ? 'Expand Quick Access' : 'Collapse Quick Access'}
            style={{
              background: 'rgba(148, 163, 184, 0.12)',
              border: '1px solid rgba(148, 163, 184, 0.25)',
              color: '#cbd5e1',
              borderRadius: '4px',
              padding: '1px 5px',
              fontSize: '0.7rem',
              cursor: 'pointer',
              lineHeight: 1.2,
            }}
          >
            {isSectionCollapsed ? '▶' : '▼'}
          </button>
        </div>
      </div>

      {/* Collapsible Quick Access Tree Body */}
      {!isSectionCollapsed && (
        <div
          ref={containerRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            const target = e.target as HTMLElement;
            if (target.closest('[data-qa-node="true"]')) return;
            containerRef.current?.focus();
            setMarquee({
              startX: e.clientX,
              startY: e.clientY,
              curX: e.clientX,
              curY: e.clientY,
            });
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverGroupId('ROOT');
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragOverGroupId(null);
          }}
          onDrop={(e) => handleDropOnGroup(e, null)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setQaMenu({
              x: e.clientX,
              y: e.clientY,
              targetKind: 'root',
              targetId: null,
            });
          }}
          style={{
            outline: 'none',
            padding: '2px 0 6px 0',
            borderRadius: '5px',
            backgroundColor: dragOverGroupId === 'ROOT' ? 'rgba(56, 189, 248, 0.08)' : 'transparent',
          }}
        >
          {visibleNodes.length === 0 ? (
            <div
              style={{
                padding: '5px 8px',
                fontSize: '0.76rem',
                color: 'var(--mhz-text-dim)',
                fontStyle: 'italic',
              }}
            >
              Right-click any folder → Add to Quick Access
            </div>
          ) : (
            visibleNodes.map((node) => {
              const isGroup = node.kind === 'group';
              const isExpanded = isGroup && expandedGroupIds.has(node.id);
              const isMultiSelected = !isGroup && selectedItemIds.has(node.id);
              const isCurrentPath = !isGroup && node.path === selectedPath;
              const isActiveGrp = isGroup && activeGroupId === node.id;
              const isCut =
                !isGroup && qaClipboard?.op === 'cut' && qaClipboard.itemIds.includes(node.id);
              const isDragOver = isGroup && dragOverGroupId === node.id;

              return (
                <div
                  key={node.id}
                  data-qa-node="true"
                  ref={(el) => {
                    if (el) nodeElementsRef.current.set(node.id, el);
                    else nodeElementsRef.current.delete(node.id);
                  }}
                  draggable={!isGroup && renamingNodeId !== node.id}
                  onDragStart={(e) => {
                    if (!isGroup && node.item) handleDragStart(e, node.item);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const destGrp = isGroup ? node.id : node.parentId;
                    setDragOverGroupId(destGrp ?? 'ROOT');
                  }}
                  onDrop={(e) => {
                    const destGrp = isGroup ? node.id : node.parentId;
                    handleDropOnGroup(e, destGrp ?? null);
                  }}
                  onClick={(e) => handleNodeClick(e, node)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    containerRef.current?.focus();
                    if (!isGroup && node.item) {
                      if (!selectedItemIds.has(node.id)) {
                        setSelectedItemIds(new Set([node.id]));
                        setAnchorItemId(node.id);
                      }
                      setActiveGroupId(node.parentId);
                      setFocusedNodeId(node.id);
                      setQaMenu({
                        x: e.clientX,
                        y: e.clientY,
                        targetKind: 'item',
                        targetId: node.id,
                      });
                    } else {
                      setActiveGroupId(node.id);
                      setFocusedNodeId(node.id);
                      setQaMenu({
                        x: e.clientX,
                        y: e.clientY,
                        targetKind: 'group',
                        targetId: node.id,
                      });
                    }
                  }}
                  className={`qa-item ${isCurrentPath || isMultiSelected ? 'selected' : ''}`}
                  style={{
                    paddingLeft: `${node.depth * 14 + 6}px`,
                    opacity: isCut ? 0.45 : 1,
                    backgroundColor: isDragOver
                      ? 'rgba(56, 189, 248, 0.25)'
                      : isMultiSelected
                        ? 'rgba(2, 132, 199, 0.32)'
                        : isActiveGrp
                          ? 'rgba(30, 41, 59, 0.7)'
                          : undefined,
                    border: isDragOver
                      ? '1px dashed #38bdf8'
                      : isMultiSelected
                        ? '1px solid rgba(56, 189, 248, 0.55)'
                        : '1px solid transparent',
                  }}
                  title={isGroup ? `Category Group: ${node.name}` : node.path}
                >
                  <span style={{ flexShrink: 0 }}>
                    {isGroup ? (isExpanded ? '📂' : '📁') : '📌'}
                  </span>

                  {renamingNodeId === node.id ? (
                    <input
                      type="text"
                      value={renamingText}
                      onChange={(e) => setRenamingText(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') handleFinishRename();
                        else if (e.key === 'Escape') setRenamingNodeId(null);
                      }}
                      onBlur={handleFinishRename}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      style={{
                        flex: 1,
                        padding: '1px 5px',
                        borderRadius: '4px',
                        border: '1px solid #38bdf8',
                        backgroundColor: '#020617',
                        color: '#f8fafc',
                        fontSize: '0.78rem',
                        outline: 'none',
                      }}
                    />
                  ) : (
                    <span
                      style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: isGroup ? 700 : 500,
                        color: isGroup ? '#fcd34d' : undefined,
                      }}
                    >
                      {node.name}
                    </span>
                  )}
                </div>
              );
            })
          )}

          {marquee &&
            createPortal(
              <div
                style={{
                  position: 'fixed',
                  left: Math.min(marquee.startX, marquee.curX),
                  top: Math.min(marquee.startY, marquee.curY),
                  width: Math.abs(marquee.curX - marquee.startX),
                  height: Math.abs(marquee.curY - marquee.startY),
                  backgroundColor: 'rgba(56, 189, 248, 0.18)',
                  border: '1px solid #38bdf8',
                  pointerEvents: 'none',
                  zIndex: 9999,
                }}
              />,
              document.body
            )}
        </div>
      )}

      {/* Right-Click Context Menu (English + Right-Aligned Shortcuts) */}
      {qaMenu &&
        createPortal(
          <div
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.min(qaMenu.x, window.innerWidth - 230),
              top: Math.min(qaMenu.y, window.innerHeight - 250),
              width: '220px',
              backgroundColor: '#0f172a',
              border: '1px solid rgba(56, 189, 248, 0.4)',
              borderRadius: '8px',
              boxShadow: '0 14px 32px rgba(0, 0, 0, 0.72)',
              padding: '5px',
              zIndex: 9999,
              fontSize: '0.79rem',
              color: '#f1f5f9',
            }}
          >
            <div
              onClick={() => {
                const parentGrp = qaMenu.targetKind === 'group' ? qaMenu.targetId : null;
                setQaMenu(null);
                handleCreateGroup(parentGrp);
              }}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 10px',
                borderRadius: '5px',
                cursor: 'pointer',
              }}
            >
              <span>📁 New Folder</span>
              <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Ctrl+Shift+N</span>
            </div>

            <div style={{ height: '1px', backgroundColor: 'rgba(148, 163, 184, 0.16)', margin: '4px 0' }} />

            <div
              onClick={() => {
                if (selectedItemIds.size === 0) return;
                setQaMenu(null);
                handleCutItems();
              }}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 10px',
                borderRadius: '5px',
                cursor: selectedItemIds.size > 0 ? 'pointer' : 'not-allowed',
                opacity: selectedItemIds.size > 0 ? 1 : 0.4,
              }}
            >
              <span>✂️ Cut (Move)</span>
              <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Ctrl+X</span>
            </div>

            <div
              onClick={() => {
                if (selectedItemIds.size === 0) return;
                setQaMenu(null);
                handleCopyItems();
              }}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 10px',
                borderRadius: '5px',
                cursor: selectedItemIds.size > 0 ? 'pointer' : 'not-allowed',
                opacity: selectedItemIds.size > 0 ? 1 : 0.4,
              }}
            >
              <span>📋 Copy</span>
              <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Ctrl+C</span>
            </div>

            <div
              onClick={() => {
                if (!qaClipboard) return;
                const destGrp =
                  qaMenu.targetKind === 'group'
                    ? qaMenu.targetId
                    : qaMenu.targetKind === 'root'
                      ? null
                      : activeGroupId;
                setQaMenu(null);
                handlePasteItems(destGrp);
              }}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 10px',
                borderRadius: '5px',
                cursor: qaClipboard ? 'pointer' : 'not-allowed',
                opacity: qaClipboard ? 1 : 0.4,
              }}
            >
              <span>📥 Paste</span>
              <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Ctrl+V</span>
            </div>

            <div style={{ height: '1px', backgroundColor: 'rgba(148, 163, 184, 0.16)', margin: '4px 0' }} />

            {qaMenu.targetId && (
              <div
                onClick={() => {
                  const targetId = qaMenu.targetId!;
                  const node = visibleNodes.find((v) => v.id === targetId);
                  setQaMenu(null);
                  if (node) handleStartRename(node.id, node.name);
                }}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 10px',
                  borderRadius: '5px',
                  cursor: 'pointer',
                }}
              >
                <span>✏️ Rename</span>
                <span style={{ color: '#64748b', fontSize: '0.72rem' }}>F2</span>
              </div>
            )}

            <div
              onClick={() => {
                const kind = qaMenu.targetKind;
                const targetId = qaMenu.targetId;
                setQaMenu(null);
                if (kind === 'group' && targetId) {
                  handleDeleteNodes('group', targetId);
                } else {
                  handleDeleteNodes('item', targetId || undefined);
                }
              }}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 10px',
                borderRadius: '5px',
                cursor: 'pointer',
                color: '#f87171',
                fontWeight: 600,
              }}
            >
              <span>🗑️ Delete</span>
              <span style={{ color: '#fca5a5', fontSize: '0.72rem', fontWeight: 400 }}>Del</span>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

export default QuickAccessTree;

