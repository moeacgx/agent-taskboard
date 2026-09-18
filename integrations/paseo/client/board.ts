import type { Task, TaskStatus } from "../shared/contracts";

export const BOARD_COLUMNS = ["ideas", "processing", "review"] as const;
export type BoardColumnId = (typeof BOARD_COLUMNS)[number];

export const BOARD_COLUMN_LABELS: Record<BoardColumnId, string> = {
  ideas: "等待认领",
  processing: "处理中",
  review: "等你确认",
};

export function boardColumnForStatus(status: TaskStatus): BoardColumnId | null {
  if (status === "in_progress" || status === "blocked") return "processing";
  if (status === "in_review") return "review";
  if (status === "backlog" || status === "todo") return "ideas";
  return null;
}

export function isMainBoardStatus(status: TaskStatus): boolean {
  return boardColumnForStatus(status) !== null;
}

export function orderBoardTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) =>
    (boardColumnForStatus(left.status) ?? "zzz").localeCompare(boardColumnForStatus(right.status) ?? "zzz")
    || left.sortOrder - right.sortOrder
    || left.createdAt.localeCompare(right.createdAt),
  );
}

export function calculateDropSortOrder(tasks: Task[], targetIndex: number): number {
  if (tasks.length === 0) return 1000;
  const index = Math.max(0, Math.min(targetIndex, tasks.length));
  const previous = tasks[index - 1] ?? null;
  const next = tasks[index] ?? null;
  if (!previous && next) return next.sortOrder - 1000;
  if (previous && !next) return previous.sortOrder + 1000;
  if (previous && next) return (previous.sortOrder + next.sortOrder) / 2;
  return 1000;
}
