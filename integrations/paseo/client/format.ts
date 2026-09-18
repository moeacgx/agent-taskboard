import type { PluginTheme } from "@getpaseo/plugin";

import type { TaskPriority, TaskStatus } from "../shared/contracts";

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "待规划",
  todo: "待办",
  in_progress: "进行中",
  in_review: "待验收",
  blocked: "阻塞",
  done: "已完成",
  canceled: "已取消",
};

export const STATUS_ORDER: TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
];

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

export const PRIORITY_ORDER: TaskPriority[] = ["urgent", "high", "medium", "low", "none"];

export function statusColor(theme: PluginTheme, status: TaskStatus): string {
  switch (status) {
    case "done":
      return theme.colors.statusSuccess;
    case "in_review":
      return theme.colors.accent;
    case "blocked":
      return theme.colors.statusDanger;
    case "canceled":
      return theme.colors.foregroundMuted;
    case "in_progress":
      return theme.colors.statusWarning;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "刚刚";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} 分钟前`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)} 小时前`;
  return `${Math.floor(diffMs / day)} 天前`;
}
