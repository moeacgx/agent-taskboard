import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { listenForOutsidePointerDown } from "../menuEvents";
import type { PaseoWorkspaceChoice } from "../paseo-bridge";
import { LinearIcon } from "./LinearIcon";
import { TaskboardIcon } from "./TaskboardIcon";

export interface PaseoWorkspaceOption extends PaseoWorkspaceChoice {
  path: string;
}

interface PaseoWorkspacePickerProps {
  options: PaseoWorkspaceOption[];
  value: string;
  onChange: (id: string) => void;
}

export function PaseoWorkspacePicker({ options, value, onChange }: PaseoWorkspacePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const selected = options.find((option) => option.id === value) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = useMemo(() => ([
    { kind: "project" as const, label: "项目", options: options.filter((option) => option.kind === "project") },
    { kind: "workspace" as const, label: "工作区", options: options.filter((option) => option.kind === "workspace") },
  ].map((group) => ({
    ...group,
    options: group.options.filter((option) => (
      !normalizedQuery
      || `${option.name ?? ""} ${option.path}`.toLocaleLowerCase().includes(normalizedQuery)
    )),
  })).filter((group) => group.options.length > 0)), [normalizedQuery, options]);
  const visibleCount = groups.reduce((count, group) => count + group.options.length, 0);
  const portalTarget = triggerRef.current?.closest("dialog, [role='dialog']") ?? document.body;

  function closePicker(restoreFocus = false) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function optionElements(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='option']") ?? []);
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      requestAnimationFrame(() => closePicker());
      return;
    }
    const elements = optionElements();
    const currentIndex = elements.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (elements.length === 0) return;
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = currentIndex < 0
        ? direction === 1 ? 0 : elements.length - 1
        : Math.max(0, Math.min(elements.length - 1, currentIndex + direction));
      elements[nextIndex]?.focus();
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
    const top = openAbove ? triggerRect.top - menuRect.height - gap : triggerRect.bottom + gap;
    setPosition({
      left: Math.max(edge, Math.min(triggerRect.left, window.innerWidth - menuRect.width - edge)),
      top: Math.max(edge, Math.min(top, window.innerHeight - menuRect.height - edge)),
    });
  }, [open, visibleCount]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    const stopOutside = listenForOutsidePointerDown([rootRef, menuRef], () => closePicker());
    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
    }
    function closeFromViewportChange(event: Event) {
      if (event.type === "scroll" && menuRef.current?.contains(event.target as Node)) return;
      closePicker();
    }
    window.addEventListener("keydown", closeFromEscape);
    const frame = requestAnimationFrame(() => {
      window.addEventListener("resize", closeFromViewportChange);
      window.addEventListener("scroll", closeFromViewportChange, true);
    });
    return () => {
      stopOutside();
      window.removeEventListener("keydown", closeFromEscape);
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="composer-popover task-property-popover paseo-workspace-popover"
      role="listbox"
      aria-label="选择新 Agent 工作区"
      style={{ position: "fixed", left: position.left, top: position.top }}
      onBlur={closeFromFocusLeave}
      onKeyDown={handleMenuKeyDown}
    >
      <label className="task-filter-search">
        <span className="sr-only">搜索项目或工作区</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="搜索名称或完整路径…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="task-property-options paseo-workspace-options">
        {visibleCount === 0 ? (
          <div className="task-filter-no-results">没有匹配的项目或工作区</div>
        ) : groups.map((group) => (
          <div role="group" aria-label={group.label} key={group.kind}>
            <div className="task-filter-section-label">{group.label}</div>
            {group.options.map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={option.id === value}
                className="task-property-option paseo-workspace-option"
                title={option.path}
                key={option.id}
                onClick={() => {
                  closePicker(true);
                  if (option.id !== value) onChange(option.id);
                }}
              >
                <span className="task-property-option-icon">
                  {option.kind === "project"
                    ? <TaskboardIcon name="projectFolder" />
                    : <LinearIcon name="folder" />}
                </span>
                <span className="paseo-workspace-option-copy">
                  <span className="paseo-workspace-option-title">{option.name ?? option.path}</span>
                  <span className="paseo-workspace-option-path">{option.path}</span>
                </span>
                {option.id === value && (
                  <span className="task-property-option-check"><LinearIcon name="check" /></span>
                )}
              </button>
            ))}
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
        className="property-control property-development"
        aria-label="新 Agent 工作区"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected?.path ?? "选择工作区"}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span className="task-property-trigger-icon">
          {selected?.kind === "project"
            ? <TaskboardIcon name="projectFolder" />
            : <LinearIcon name="folder" />}
        </span>
        <span className="task-property-trigger-label">{selected?.name ?? selected?.path ?? "选择工作区"}</span>
      </button>
      {menu}
    </div>
  );
}
