import { listenForOutsidePointerDown } from "../menuEvents";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ConversationIcon } from "./SemanticIcons";
import { LinearIcon } from "./LinearIcon";
import { TaskboardIcon } from "./TaskboardIcon";
import { ProviderIcon } from "../providerIcons";

export type PaseoAssigneeOptionGroup = "self" | "profile" | "provider" | "agent";
export type PaseoAssigneeOptionKind = "choice" | "provider" | "agent-browser";

export interface PaseoAssigneeOption {
  id: string;
  label: string;
  detail?: string;
  group: PaseoAssigneeOptionGroup;
  kind?: PaseoAssigneeOptionKind;
  providerId?: string;
  provider?: string;
  model?: string | null;
  workspacePath?: string;
  agentId?: string;
  modeId?: string;
  thinkingOptionId?: string;
  iconDataUrl?: string | null;
  /** Profile icon registry key; it is resolved locally, never loaded as a URL. */
  profileIcon?: string | null;
  /** 模型和非快捷 Profile 仅在二级页或搜索结果中展示。 */
  hiddenFromRoot?: boolean;
  /** 新建 Agent 计划需要单独选择工作区。 */
  requiresWorkspace?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export interface PaseoAssigneePickerProps {
  options: PaseoAssigneeOption[];
  value: string | null;
  loading?: boolean;
  error?: string | null;
  onRefresh: () => void;
  onChange: (id: string) => void;
}

const ROOT_GROUPS: ReadonlyArray<{ id: PaseoAssigneeOptionGroup; label: string }> = [
  { id: "self", label: "我" },
  { id: "profile", label: "常用 Profile" },
  { id: "provider", label: "选择提供方" },
  { id: "agent", label: "已有会话" },
];

function optionIcon(option: PaseoAssigneeOption): ReactNode {
  if (option.provider) {
    return <ProviderIcon
      provider={option.provider}
      iconDataUrl={option.iconDataUrl}
      profileIcon={option.profileIcon}
    />;
  }
  if (option.group === "self") return <LinearIcon name="myIssues" />;
  if (option.group === "profile" || option.group === "provider") return <TaskboardIcon name="aiLauncher" />;
  return <ConversationIcon />;
}

type PickerView =
  | { kind: "root" }
  | { kind: "models"; providerId: string; label: string }
  | { kind: "agents" };

function optionMatches(option: PaseoAssigneeOption, query: string): boolean {
  return !query || `${option.label} ${option.detail ?? ""} ${option.disabledReason ?? ""}`
    .toLocaleLowerCase()
    .includes(query);
}

export function PaseoAssigneePicker({
  options,
  value,
  loading = false,
  error = null,
  onRefresh,
  onChange,
}: PaseoAssigneePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [view, setView] = useState<PickerView>({ kind: "root" });
  const selected = options.find((option) => option.id === value) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groupedOptions = useMemo(() => {
    if (view.kind === "models") {
      return [{
        id: "models",
        label: view.label,
        options: options.filter((option) => (
          option.group === "profile"
          && option.providerId === view.providerId
          && optionMatches(option, normalizedQuery)
        )),
      }];
    }
    if (view.kind === "agents") {
      return [{
        id: "agents",
        label: "绑定已有会话",
        options: options.filter((option) => (
          option.group === "agent"
          && (option.kind ?? "choice") === "choice"
          && optionMatches(option, normalizedQuery)
        )),
      }];
    }
    if (normalizedQuery) {
      return [{
        id: "search",
        label: "搜索模型和 Profile",
        options: options.filter((option) => (
          (option.kind ?? "choice") === "choice"
          && option.group !== "agent"
          && optionMatches(option, normalizedQuery)
        )),
      }];
    }
    return ROOT_GROUPS.map((group) => ({
      ...group,
      options: options.filter((option) => option.group === group.id && !option.hiddenFromRoot),
    })).filter((group) => group.options.length > 0);
  }, [normalizedQuery, options, view]);
  const visibleOptionCount = groupedOptions.reduce((total, group) => total + group.options.length, 0);
  const portalTarget = triggerRef.current?.closest("dialog, [role='dialog']") ?? document.body;

  function closePicker({ restoreFocus = false } = {}) {
    setOpen(false);
    setQuery("");
    setView({ kind: "root" });
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function optionElements(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='option']:not(:disabled)") ?? []);
  }

  function choose(option: PaseoAssigneeOption) {
    if (option.disabled) return;
    if (option.kind === "provider" && option.providerId) {
      setView({ kind: "models", providerId: option.providerId, label: option.label });
      setQuery("");
      requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
      return;
    }
    if (option.kind === "agent-browser") {
      setView({ kind: "agents" });
      setQuery("");
      requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
      return;
    }
    closePicker({ restoreFocus: true });
    if (option.id !== value) onChange(option.id);
  }

  function moveOptionFocus(direction: 1 | -1) {
    const elements = optionElements();
    if (elements.length === 0) return;
    const currentIndex = elements.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = currentIndex < 0
      ? direction === 1 ? 0 : elements.length - 1
      : Math.max(0, Math.min(elements.length - 1, currentIndex + direction));
    elements[nextIndex]?.focus();
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      requestAnimationFrame(() => closePicker());
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveOptionFocus(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      const elements = optionElements();
      if (elements.length === 0) return;
      event.preventDefault();
      elements[event.key === "Home" ? 0 : elements.length - 1]?.focus();
    }
  }

  function closeFromFocusLeave(event: FocusEvent<HTMLElement>) {
    if (menuRef.current?.matches(":active")) return;
    const next = event.relatedTarget as Node | null;
    if (!next || (!rootRef.current?.contains(next) && !menuRef.current?.contains(next))) closePicker();
  }

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gap = 4;
    const edge = 8;
    const openAbove = triggerRect.bottom + gap + menuRect.height > window.innerHeight - edge
      && triggerRect.top - gap - menuRect.height >= edge;
    const preferredTop = openAbove ? triggerRect.top - menuRect.height - gap : triggerRect.bottom + gap;
    setPosition({
      left: Math.max(edge, Math.min(triggerRect.left, window.innerWidth - menuRect.width - edge)),
      top: Math.max(edge, Math.min(preferredTop, window.innerHeight - menuRect.height - edge)),
    });
  }, [error, loading, open, view, visibleOptionCount]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    const stopOutside = listenForOutsidePointerDown([rootRef, menuRef], () => closePicker());
    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closePicker({ restoreFocus: true });
    }
    function closeFromViewportChange(event: Event) {
      if (event.type === "scroll" && menuRef.current?.contains(event.target as Node)) return;
      closePicker();
    }
    window.addEventListener("keydown", closeFromEscape);
    const viewportListenerFrame = requestAnimationFrame(() => {
      window.addEventListener("resize", closeFromViewportChange);
      window.addEventListener("scroll", closeFromViewportChange, true);
    });
    return () => {
      stopOutside();
      window.removeEventListener("keydown", closeFromEscape);
      cancelAnimationFrame(viewportListenerFrame);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="composer-popover task-property-popover paseo-assignee-popover"
      role="listbox"
      aria-label="选择负责人"
      aria-busy={loading || undefined}
      style={{ position: "fixed", left: position.left, top: position.top }}
      onBlur={closeFromFocusLeave}
      onKeyDown={handleMenuKeyDown}
    >
      {view.kind !== "root" && (
        <div className="paseo-assignee-popover-header" style={{ display: "flex", alignItems: "center", gap: 4, minHeight: 32, paddingInline: 2 }}>
          <button
            type="button"
            className="icon-button"
            aria-label="返回负责人选择"
            onClick={() => {
              setQuery("");
              setView({ kind: "root" });
            }}
          >
            <LinearIcon name="chevronLeft" />
          </button>
          <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {view.kind === "models" ? view.label : "绑定已有会话"}
          </strong>
        </div>
      )}
      <label className="task-filter-search">
        <span className="sr-only">搜索模型或负责人</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          disabled={loading}
          placeholder={view.kind === "agents" ? "搜索已有会话…" : "搜索模型或 Profile…"}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="task-property-options paseo-assignee-options">
        {loading ? (
          <div className="task-filter-no-results" role="status">正在加载负责人…</div>
        ) : error ? (
          <>
            <div className="task-filter-no-results" role="alert">加载负责人失败：{error}</div>
            <div className="task-filter-footer"><button type="button" className="task-filter-clear-all" onClick={onRefresh}>重试</button></div>
          </>
        ) : visibleOptionCount === 0 ? (
          <div className="task-filter-no-results">
            {normalizedQuery ? "没有匹配的模型或 Profile" : view.kind === "agents" ? "暂无可绑定的已有会话" : "暂无可用负责人"}
          </div>
        ) : groupedOptions.map((group) => (
          <div key={group.id} role="group" aria-label={group.label}>
            <div className="task-filter-section-label">{group.label}</div>
            {group.options.map((option) => {
              const detail = option.disabled ? option.disabledReason ?? option.detail : option.detail;
              const opensSubmenu = option.kind === "provider" || option.kind === "agent-browser";
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={!opensSubmenu && option.id === value}
                  aria-disabled={option.disabled || undefined}
                  aria-haspopup={opensSubmenu ? "listbox" : undefined}
                  disabled={option.disabled}
                  className={`task-property-option paseo-assignee-option${option.disabled ? " task-filter-unmatched" : ""}`}
                  title={option.disabledReason ?? option.detail}
                  key={option.id}
                  onClick={() => choose(option)}
                >
                  <span className="task-property-option-icon">{optionIcon(option)}</span>
                  <span className="paseo-assignee-option-copy">
                    <span className="paseo-assignee-option-title">{option.label}</span>
                    {detail && <span className="paseo-assignee-option-detail">{detail}</span>}
                  </span>
                  {opensSubmenu ? (
                    <span className="task-property-option-check"><LinearIcon name="chevronRight" /></span>
                  ) : option.id === value && (
                    <span className="task-property-option-check"><LinearIcon name="check" /></span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>,
    portalTarget,
  ) : null;

  return (
    <div ref={rootRef} className="task-property-picker" onBlur={closeFromFocusLeave}>
      <button
        ref={triggerRef}
        type="button"
        className="property-control property-assignee"
        aria-label="负责人"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected ? `负责人：${selected.label}` : "选择负责人"}
        onClick={() => setOpen((current) => {
          if (current) {
            setQuery("");
            setView({ kind: "root" });
          }
          return !current;
        })}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span className="task-property-trigger-icon">
          {selected ? optionIcon(selected) : <LinearIcon name="myIssues" />}
        </span>
        <span className="task-property-trigger-label">{selected?.label ?? "选择负责人"}</span>
      </button>
      {menu}
    </div>
  );
}
