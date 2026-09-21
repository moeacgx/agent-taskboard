import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import type {
  IssueRelationType,
  Task,
  TaskRelationSummary,
} from "../types";
import { useTaskboardI18n } from "../i18n";
import { ActorAvatar } from "./ActorAvatar";
import { LinearIcon } from "./LinearIcon";
import {
  BlockingRelationIcon,
  PlusIcon,
  RelationIcon,
  StatusIcon,
} from "./SemanticIcons";

export interface RelationMutationResult {
  task: Task;
  relatedTask: Task;
}

export function IssuePickerContent({
  candidates,
  selectedIds,
  disabled,
  onSelect,
  onEscape,
}: {
  candidates: Task[];
  selectedIds?: ReadonlySet<string>;
  disabled?: boolean;
  onSelect: (task: Task) => void | Promise<void>;
  onEscape: () => void;
}) {
  const { text } = useTaskboardI18n();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [savingId, setSavingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return candidates;
    return candidates.filter((task) => (
      (task.externalKey ?? task.identifier).toLocaleLowerCase().includes(normalized)
      || task.title.toLocaleLowerCase().includes(normalized)
    ));
  }, [candidates, query]);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  async function choose(task: Task) {
    setSavingId(task.id);
    try {
      await onSelect(task);
    } catch {
    } finally {
      setSavingId(null);
    }
  }

  return (
    <>
      <div className="issue-relation-search">
        <LinearIcon name="search" />
        <input
          ref={inputRef}
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="issue-relation-results"
          aria-activedescendant={results[activeIndex] ? `relation-option-${results[activeIndex].id}` : undefined}
          placeholder={text("搜索议题…", "Search issues…")}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              if (event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              const activeResult = results[activeIndex];
              if (activeResult) void choose(activeResult);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onEscape();
            } else if (event.key === "ArrowDown" && results.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % results.length);
            } else if (event.key === "ArrowUp" && results.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + results.length) % results.length);
            }
          }}
        />
      </div>
      <div
        className={`issue-relation-results${selectedIds ? " has-selections" : ""}`}
        id="issue-relation-results"
        role="listbox"
      >
        {results.length > 0 ? results.map((candidate, index) => {
          const selected = selectedIds?.has(candidate.id) ?? false;
          const className = [
            index === activeIndex ? "is-active" : "",
            selected ? "is-selected" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              id={`relation-option-${candidate.id}`}
              className={className}
              type="button"
              role="option"
              aria-selected={selectedIds ? selected : index === activeIndex}
              disabled={disabled || savingId !== null}
              key={candidate.id}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => void choose(candidate)}
            >
              <StatusIcon status={candidate.status} size={14} />
              <span className="issue-relation-option-id">{candidate.externalKey ?? candidate.identifier}</span>
              <span className="issue-relation-option-title">{candidate.title}</span>
              {selectedIds && (
                <span className="issue-relation-option-check">
                  {selected && <LinearIcon name="check" />}
                </span>
              )}
            </button>
          );
        }) : (
          <p className="issue-relation-empty">{text("没有匹配的议题", "No matching issues")}</p>
        )}
      </div>
    </>
  );
}

interface RelationActions {
  task: Task;
  tasks: Task[];
  onOpenTask: (task: TaskRelationSummary) => void;
  onAddRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) => Promise<RelationMutationResult>;
  onRemoveRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) => Promise<RelationMutationResult>;
}

export function IssuePicker({
  label,
  candidates,
  disabled,
  onSelect,
}: {
  label: string;
  candidates: Task[];
  disabled?: boolean;
  onSelect: (task: Task) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="issue-relation-picker" ref={rootRef}>
      <button
        className="issue-relation-add"
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <PlusIcon color="currentColor" size={13} />
        <span>{label}</span>
      </button>
      {open && (
        <div className="issue-relation-popover">
          <div className="issue-relation-popover-title">{label}</div>
          <IssuePickerContent
            candidates={candidates}
            disabled={disabled}
            onEscape={() => setOpen(false)}
            onSelect={async (task) => {
              await onSelect(task);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

function descendantIds(task: Task, tasks: Task[]) {
  const descendants = new Set<string>();
  const queue = [...task.relations.subIssues.map((item) => item.id)];
  const taskById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (descendants.has(id)) continue;
    descendants.add(id);
    const child = taskById.get(id);
    if (child) queue.push(...child.relations.subIssues.map((item) => item.id));
  }
  return descendants;
}

function IssueRelationRow({
  issue,
  onOpen,
  onRemove,
  removing,
  showAssignee = false,
}: {
  issue: TaskRelationSummary;
  onOpen: () => void;
  onRemove: () => void;
  removing: boolean;
  showAssignee?: boolean;
}) {
  const { text } = useTaskboardI18n();
  return (
    <div className="issue-relation-row">
      <button className="issue-relation-target" type="button" onClick={onOpen}>
        <StatusIcon status={issue.status} size={14} />
        <span className="issue-relation-id">{issue.externalKey ?? issue.identifier}</span>
        <span className="issue-relation-title">{issue.title}</span>
        {showAssignee && <ActorAvatar actor={issue.assignee} className="issue-relation-assignee" />}
      </button>
      <button
        className="issue-relation-remove"
        type="button"
        aria-label={text(
          `移除 ${issue.externalKey ?? issue.identifier}`,
          `Remove ${issue.externalKey ?? issue.identifier}`,
        )}
        disabled={removing}
        onClick={onRemove}
      >
        <LinearIcon name="close" />
      </button>
    </div>
  );
}

export function IssueParentLink({
  task,
  tasks,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
}: RelationActions) {
  const { text } = useTaskboardI18n();
  const [saving, setSaving] = useState(false);
  const parent = task.relations.parent;
  const excluded = descendantIds(task, tasks);
  excluded.add(task.id);
  const candidates = tasks.filter((candidate) => (
    candidate.archivedAt === null
    && !excluded.has(candidate.id)
    && candidate.id !== parent?.id
  ));

  return (
    <div className={`issue-parent-link${parent ? " has-parent" : ""}`}>
      {parent && (
        <>
          <span className="issue-parent-prefix">{text("子议题属于", "Sub-issue of")}</span>
          <IssueRelationRow
            issue={parent}
            removing={saving}
            onOpen={() => onOpenTask(parent)}
            onRemove={() => {
              setSaving(true);
              void onRemoveRelation(task, "parent", parent.id)
                .catch(() => undefined)
                .finally(() => setSaving(false));
            }}
          />
        </>
      )}
      <IssuePicker
        label={parent
          ? text("更换父议题", "Change parent issue")
          : text("设置父议题", "Set parent issue")}
        candidates={candidates}
        disabled={saving}
        onSelect={async (candidate) => {
          setSaving(true);
          try {
            await onAddRelation(task, "parent", candidate.id);
          } finally {
            setSaving(false);
          }
        }}
      />
    </div>
  );
}

export function IssueSubIssues({
  task,
  tasks,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
}: RelationActions) {
  const { text } = useTaskboardI18n();
  const [savingId, setSavingId] = useState<string | null>(null);
  const subIssues = task.relations.subIssues;
  const done = subIssues.filter((issue) => issue.status === "done").length;
  const directIds = new Set(subIssues.map((issue) => issue.id));
  const ancestors = new Set<string>([task.id]);
  let parent = task.relations.parent;
  const taskById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  while (parent && !ancestors.has(parent.id)) {
    ancestors.add(parent.id);
    parent = taskById.get(parent.id)?.relations.parent ?? null;
  }
  const candidates = tasks.filter((candidate) => (
    candidate.archivedAt === null
    && !ancestors.has(candidate.id)
    && !directIds.has(candidate.id)
  ));
  const progress = subIssues.length > 0 ? Math.round((done / subIssues.length) * 100) : 0;

  return (
    <section className="issue-sub-issues" aria-labelledby="sub-issues-heading">
      <header>
        <div>
          <h2 id="sub-issues-heading">{text("子议题", "Sub-issues")}</h2>
          {subIssues.length > 0 && (
            <span className="sub-issue-summary">
              <span
                className="sub-issue-progress"
                style={{ "--sub-issue-progress": `${progress}%` } as CSSProperties}
                aria-hidden="true"
              />
              {done}/{subIssues.length}
            </span>
          )}
        </div>
        <IssuePicker
          label={text("添加子议题", "Add sub-issue")}
          candidates={candidates}
          disabled={savingId !== null}
          onSelect={async (candidate) => {
            setSavingId(candidate.id);
            try {
              await onAddRelation(candidate, "parent", task.id);
            } finally {
              setSavingId(null);
            }
          }}
        />
      </header>
      {subIssues.length > 0 && (
        <div className="issue-sub-issue-list">
          {subIssues.map((issue) => {
            const child = taskById.get(issue.id);
            return (
              <IssueRelationRow
                issue={issue}
                key={issue.id}
                showAssignee
                removing={savingId === issue.id}
                onOpen={() => onOpenTask(issue)}
                onRemove={() => {
                  if (!child) return;
                  setSavingId(issue.id);
                  void onRemoveRelation(child, "parent", task.id)
                    .catch(() => undefined)
                    .finally(() => setSavingId(null));
                }}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

const RELATION_GROUPS = [
  { type: "blocked_by", field: "blockedBy", chineseLabel: "需要先完成", englishLabel: "Complete first", chineseDescription: "先完成这些任务，再做当前任务。", englishDescription: "Finish these tasks before working on the current task.", chineseAddLabel: "添加需要先完成的任务", englishAddLabel: "Add task to complete first", tone: "blocked-by" },
  { type: "blocks", field: "blocks", chineseLabel: "后续依赖任务", englishLabel: "Downstream dependent tasks", chineseDescription: "这些任务需要等当前任务完成。", englishDescription: "These tasks should wait for the current task to be completed.", chineseAddLabel: "添加后续依赖任务", englishAddLabel: "Add downstream dependent task", tone: "blocks" },
  { type: "related", field: "related", chineseLabel: "相关任务", englishLabel: "Related tasks", chineseDescription: "仅供参考，没有先后顺序。", englishDescription: "For reference only; there is no required order.", chineseAddLabel: "添加相关任务", englishAddLabel: "Add related task", tone: "related" },
] as const;

export function IssueRelationSidebar({
  task,
  tasks,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
  paseoMode = false,
}: RelationActions & { paseoMode?: boolean }) {
  const { text } = useTaskboardI18n();
  const [savingKey, setSavingKey] = useState<string | null>(null);

  return (
    <section className="issue-relation-sidebar" aria-labelledby="relations-heading">
      <h2 id="relations-heading">{text("任务关系", "Task relationships")}</h2>
      {paseoMode && (
        <p className="issue-relation-scope-note">{text(
          "目前仅记录先后关系，不会自动阻止或启动 Agent。",
          "These relationships are informational only; they do not automatically block or start an Agent.",
        )}</p>
      )}
      {RELATION_GROUPS.map((group) => {
        const label = text(group.chineseLabel, group.englishLabel);
        const issues = task.relations[group.field];
        const existing = new Set(issues.map((issue) => issue.id));
        const candidates = tasks.filter((candidate) => (
          candidate.archivedAt === null
          && candidate.id !== task.id
          && !existing.has(candidate.id)
        ));
        return (
          <div className={`issue-relation-group is-${group.tone}`} key={group.type}>
            <header>
              <div className="issue-relation-heading">
                <span>
                  {group.type === "related" ? (
                    <RelationIcon color="currentColor" size={14} />
                  ) : (
                    <BlockingRelationIcon type={group.type} color="currentColor" />
                  )}
                  {label}
                </span>
                <small>{text(group.chineseDescription, group.englishDescription)}</small>
              </div>
              <IssuePicker
                label={text(group.chineseAddLabel, group.englishAddLabel)}
                candidates={candidates}
                disabled={savingKey !== null}
                onSelect={async (candidate) => {
                  const key = `${group.type}:${candidate.id}`;
                  setSavingKey(key);
                  try {
                    await onAddRelation(task, group.type, candidate.id);
                  } finally {
                    setSavingKey(null);
                  }
                }}
              />
            </header>
            {issues.map((issue) => (
              <IssueRelationRow
                issue={issue}
                key={issue.id}
                removing={savingKey === `${group.type}:${issue.id}`}
                onOpen={() => onOpenTask(issue)}
                onRemove={() => {
                  const key = `${group.type}:${issue.id}`;
                  setSavingKey(key);
                  void onRemoveRelation(task, group.type, issue.id)
                    .catch(() => undefined)
                    .finally(() => setSavingKey(null));
                }}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}
