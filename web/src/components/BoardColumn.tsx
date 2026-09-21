import type { DragEvent } from "react";
import { useTaskCardDragPreview } from "../useTaskCardDragPreview";
import type { ActorIdentity, Task, TaskDraft, TaskStatus } from "../types";
import { taskStatusLabel, useTaskboardI18n } from "../i18n";
import type { TaskCardPresentation, TaskConversationItem } from "../taskConversations";
import { TaskCard } from "./TaskCard";
import { LinearIcon } from "./LinearIcon";
import { DeleteIcon, PlusIcon, StatusIcon } from "./SemanticIcons";

export const STATUS_DETAILS: Record<
  TaskStatus,
  { label: string; tone: string }
> = {
  backlog: { label: "待立项", tone: "backlog" },
  todo: { label: "等待认领", tone: "todo" },
  in_progress: { label: "处理中", tone: "progress" },
  in_review: { label: "等你确认", tone: "review" },
  blocked: { label: "遇到阻碍", tone: "blocked" },
  done: { label: "完成", tone: "done" },
  canceled: { label: "取消", tone: "canceled" },
};

interface BoardColumnProps {
  scrollRef: (element: HTMLDivElement | null) => void;
  status: TaskStatus;
  label?: string;
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  emptyMessage: string;
  isDropTarget: boolean;
  draggedTaskId: string | null;
  draggedTaskIds?: ReadonlySet<string>;
  draggedTaskHeight: number;
  movingTaskId: string | null;
  batchMovingTaskIds?: ReadonlySet<string>;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  availableLabels: string[];
  projectNames?: Record<string, string>;
  currentUser: ActorIdentity;
  showCover: boolean;
  showBody: boolean;
  createEnabled?: boolean;
  onCreateLabel: (label: string, projectId?: string) => Promise<void>;
  onCreate: (status: TaskStatus) => void;
  onEdit: (task: Task) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onComplete: (task: Task) => Promise<void>;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: TaskStatus) => void;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null) => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
  ideaSelection?: {
    active: boolean;
    selectedIds: ReadonlySet<string>;
    canSelect: (task: Task) => boolean;
    onToggleMode: () => void;
    onToggleTask: (task: Task) => void;
    onMerge: () => void;
    onDelete: () => void;
    moving?: boolean;
  };
}

export function BoardColumn({
  scrollRef,
  status,
  label: labelOverride,
  tasks,
  presentations,
  emptyMessage,
  isDropTarget,
  draggedTaskId,
  draggedTaskIds = new Set<string>(),
  draggedTaskHeight,
  movingTaskId,
  batchMovingTaskIds = new Set<string>(),
  settlingTaskId,
  contextMenuTaskId,
  availableLabels,
  projectNames,
  currentUser,
  showCover,
  showBody,
  createEnabled = true,
  onCreateLabel,
  onCreate,
  onEdit,
  onUpdate,
  onComplete,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onOpenConversation,
  ideaSelection,
}: BoardColumnProps) {
  const { language, text } = useTaskboardI18n();
  const details = STATUS_DETAILS[status];
  const label = labelOverride ?? taskStatusLabel(language, status);
  const { findDropBefore, clearDropPreview, updateDropPreview, leaveDropPreview, getTaskDragShift } =
    useTaskCardDragPreview({ tasks, draggedTaskId, draggedTaskIds, draggedTaskHeight, isDropTarget });

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const taskId =
      event.dataTransfer.getData("application/x-taskboard-task") ||
      event.dataTransfer.getData("text/plain");
    if (taskId) onDrop(status, taskId, findDropBefore(event.currentTarget, event.clientY));
    clearDropPreview();
  }

  return (
    <section
      className={`board-column status-${status}${isDropTarget ? " is-drop-target" : ""}`}
      aria-labelledby={`column-${status}`}
      onDragEnter={() => onDragEnter(status)}
      onDragOver={(event) => {
        onDragEnter(status);
        updateDropPreview(event);
      }}
      onDragLeave={leaveDropPreview}
      onDrop={handleDrop}
    >
      <header className="column-header">
        <div className="column-heading">
          <span className={`column-status-icon status-icon-${details.tone}`}>
            <StatusIcon status={status} color="var(--column-status-color)" size={14} />
          </span>
          <h2 id={`column-${status}`}>
            {label}{tasks.length > 0 ? ` ${tasks.length}` : ""}
          </h2>
        </div>
        {(createEnabled || ideaSelection) && (
          <div className="column-actions">
            {ideaSelection && (
              <>
                <button
                  type="button"
                  className={`column-selection-action${ideaSelection.active ? " is-active" : ""}`}
                  aria-pressed={ideaSelection.active}
                  disabled={ideaSelection.moving}
                  onClick={ideaSelection.onToggleMode}
                >
                  {ideaSelection.active ? text("取消", "Cancel") : text("多选", "Select")}
                </button>
                {ideaSelection.active && ideaSelection.selectedIds.size >= 2 && (
                  <button
                    type="button"
                    className="column-selection-action is-merge"
                    disabled={ideaSelection.moving}
                    onClick={ideaSelection.onMerge}
                  >
                    <LinearIcon name="check" />
                    {text(`合并 ${ideaSelection.selectedIds.size} 项`, `Merge ${ideaSelection.selectedIds.size}`)}
                  </button>
                )}
                {ideaSelection.active && ideaSelection.selectedIds.size >= 1 && (
                  <button
                    type="button"
                    className="column-selection-action is-delete"
                    disabled={ideaSelection.moving}
                    onClick={ideaSelection.onDelete}
                  >
                    <DeleteIcon color="currentColor" size={12} />
                    {text(`删除 ${ideaSelection.selectedIds.size} 项`, `Delete ${ideaSelection.selectedIds.size}`)}
                  </button>
                )}
              </>
            )}
            {createEnabled && (
            <button
              type="button"
              className="icon-button add-task-button"
              onClick={() => onCreate(status)}
              aria-label={text(`在${label}中新建议题`, `Create issue in ${label}`)}
              title={text(`添加到${label}`, `Add to ${label}`)}
            >
              <PlusIcon color="var(--column-status-color)" size={12} />
            </button>
            )}
          </div>
        )}
      </header>

      <div className="column-list" ref={scrollRef}>
        {tasks.map((task) => {
          const dragShift = getTaskDragShift(task.id);
          return (
            <TaskCard
              key={task.id}
              task={task}
              presentation={presentations[task.id]}
              isDragging={draggedTaskId === task.id}
              batchDragMember={draggedTaskIds.size > 1 && draggedTaskIds.has(task.id)}
              batchDragSource={draggedTaskIds.size > 1 && draggedTaskId === task.id}
              selectionCount={ideaSelection?.selectedIds.size ?? 0}
              dragShift={dragShift}
              isMoving={movingTaskId === task.id || batchMovingTaskIds.has(task.id)}
              isSettling={settlingTaskId === task.id}
              isContextMenuOpen={contextMenuTaskId === task.id}
              availableLabels={availableLabels}
              projectName={projectNames?.[task.projectId]}
              currentUser={currentUser}
              showCover={showCover}
              showBody={showBody}
              onCreateLabel={(label) => onCreateLabel(label, task.projectId)}
              onEdit={onEdit}
              onUpdate={onUpdate}
              onComplete={onComplete}
              onContextMenu={onContextMenu}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onOpenConversation={onOpenConversation}
              selectionMode={ideaSelection?.active}
              selected={ideaSelection?.selectedIds.has(task.id)}
              selectable={ideaSelection?.canSelect(task)}
              onToggleSelection={ideaSelection?.onToggleTask}
            />
          );
        })}
        {tasks.length === 0 && <div className="column-empty">{emptyMessage}</div>}
      </div>
    </section>
  );
}
