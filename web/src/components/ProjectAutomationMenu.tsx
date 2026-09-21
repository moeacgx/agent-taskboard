import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  PaseoAgentProfile,
} from "../paseo-bridge";
import { LinearIcon } from "./LinearIcon";
import { ProjectIcon, RecurrenceIcon } from "./SemanticIcons";
import {
  PaseoProjectDefaultsDialog,
  type PaseoProjectDefaultsCatalog,
} from "./PaseoProjectDefaultsDialog";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskboardIcon } from "./TaskboardIcon";
import { useTaskboardI18n } from "../i18n";
import { listenForMenuViewportChange, listenForOutsidePointerDown } from "../menuEvents";
import type { AiChatModel } from "../types";

type AutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type IntervalMinutes = 5 | 10 | 15 | 30 | 60;

export interface AutomationOptions {
  enabledByUser: boolean;
  quotaAware: boolean;
  intervalMinutes: IntervalMinutes;
  model?: string;
  reasoningEffort?: string;
  workspacePath?: string | null;
  profile?: PaseoAgentProfile | null;
}

interface AutomationState extends AutomationOptions {
  status: AutomationStatus;
  schedulerReady?: boolean;
  quotaAvailable?: boolean;
  lastRunAt?: string | null;
  lastError?: string | null;
  quota?: {
    state: AutomationQuotaState;
    checkedAt: number;
    resetsAt?: number;
    reason?: "api-key";
  };
}

interface ProjectAutomationMenuProps {
  automation?: Partial<AutomationState>;
  models?: AiChatModel[];
  mode?: "codex" | "paseo";
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void | Promise<boolean | void>;
  onSaveDefaults?: (value: { profile: PaseoAgentProfile | null; workspacePath: string | null }) => Promise<boolean | void>;
  paseoDefaults?: PaseoProjectDefaultsCatalog;
}

const EFFORT_LABELS: Record<string, readonly [string, string]> = {
  low: ["轻度", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高 (xhigh)", "Extra high (xhigh)"],
  max: ["最高", "Maximum"],
  ultra: ["极高 (ultra)", "Ultra"],
};

const EMPTY_MODELS: AiChatModel[] = [];

function automationOptions(
  models: AiChatModel[],
  automation?: Partial<AutomationState>,
): AutomationOptions {
  const model = models.find((candidate) => candidate.slug === automation?.model) ?? models[0];
  const reasoningEffort = model?.supportedReasoningEfforts.includes(automation?.reasoningEffort ?? "")
    ? automation?.reasoningEffort
    : model?.defaultReasoningEffort;
  return {
    enabledByUser: automation?.enabledByUser ?? false,
    quotaAware: automation?.quotaAware ?? false,
    intervalMinutes: automation?.intervalMinutes ?? 5,
    ...(model ? {
      model: model.slug,
      reasoningEffort: reasoningEffort ?? model.defaultReasoningEffort,
    } : {}),
  };
}

export function ProjectAutomationMenu({
  automation,
  models = EMPTY_MODELS,
  mode = "codex",
  pending,
  error,
  unavailableReason,
  onOpen,
  onChange,
  onSaveDefaults,
  paseoDefaults,
}: ProjectAutomationMenuProps) {
  const { locale, text } = useTaskboardI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [pickerMenu, setPickerMenu] = useState<"interval" | "model" | "reasoning" | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(() => automationOptions(models, automation));
  const status = automation?.status ?? "PAUSED";
  const quota = automation?.quota;
  const paseoMode = mode === "paseo";
  const schedulerReady = automation?.schedulerReady ?? !paseoMode;
  const quotaAvailable = automation?.quotaAvailable ?? !paseoMode;
  const stateLabel = !automation?.enabledByUser
    ? text("已暂停", "Paused")
    : !schedulerReady
      ? text("等待调度器", "Waiting for scheduler")
    : automation.quotaAware && quota?.state === "blocked"
      ? text("额度暂停", "Paused by quota")
      : automation.quotaAware && quota?.state === "unavailable"
        ? text("额度不可用", "Quota unavailable")
        : automation.quotaAware && (!quota || quota.state === "unknown")
          ? text("额度未知", "Quota unknown")
          : status === "ACTIVE"
            ? text("运行中", "Running")
            : text("已暂停", "Paused");
  const selectedModel = models.find((model) => model.slug === draft.model) ?? models[0];
  const disabled = pending || (!paseoMode && !selectedModel) || Boolean(unavailableReason);

  useEffect(() => {
    if (!open) return;
    setDraft(automationOptions(models, automation));
  }, [automation, models, open]);

  useEffect(() => {
    if (!open) setPickerMenu(null);
  }, [open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      setDraft(automationOptions(models, automation));
    }
    wasPendingRef.current = pending;
  }, [automation, pending]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const stopOutside = listenForOutsidePointerDown([triggerRef, menuRef], close);
    const stopViewport = listenForMenuViewportChange(menuRef, close);
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !pickerMenu) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      stopOutside();
      stopViewport();
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [open, pickerMenu]);

  const submitChange = (next: AutomationOptions) => {
    if (disabled) return;
    setDraft(next);
    onChange(next);
  };

  function openDefaultConfiguration() {
    if (!paseoDefaults) return;
    setOpen(false);
    setDefaultsOpen(true);
  }

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label={text("自动认领待办设置", "Auto-claim settings")}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>{text("自动认领待办", "Auto-claim tasks")}</strong>
        <span className={status === "ACTIVE" ? "is-active" : "is-paused"}>
          {stateLabel}
        </span>
      </div>
      <div className="project-automation-switch">
        <span>{text("自动认领开关", "Auto-claim")}</span>
        <button
          type="button"
          className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.enabledByUser}
          disabled={disabled}
          onClick={() => submitChange({
            ...draft,
            enabledByUser: !draft.enabledByUser,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="project-automation-switch">
        <span>{text("根据额度启用/关闭", "Use quota limits")}</span>
        <button
          type="button"
          className={`board-setting-switch${draft.quotaAware ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.quotaAware}
          disabled={disabled || !quotaAvailable}
          onClick={() => submitChange({
            ...draft,
            quotaAware: !draft.quotaAware,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {!quotaAvailable && (
        <div className="project-automation-quota is-unavailable">
          {text("Paseo SDK 当前无法提供可靠额度，额度联动暂不可用。", "Paseo SDK quota data is currently unavailable, so quota-aware automation is disabled.")}
        </div>
      )}
      {quotaAvailable && draft.quotaAware && (
        <div className={`project-automation-quota is-${quota?.state ?? "unknown"}`}>
          {quota?.state === "available" && text("当前额度可用", "Quota is available")}
          {quota?.state === "blocked" && (
            quota.resetsAt
              ? text(
                `额度已用尽，预计 ${formatResetTime(quota.resetsAt, locale)} 恢复`,
                `Quota is exhausted. Expected reset: ${formatResetTime(quota.resetsAt, locale)}.`,
              )
              : text("额度已用尽，自动认领已暂停", "Quota is exhausted. Auto-claim is paused.")
          )}
          {quota?.state === "unavailable" && (
            quota.reason === "api-key"
              ? text(
                "API Key 模式不支持读取 Codex App 额度",
                "API key mode cannot read the Codex app quota.",
              )
              : text("当前账户无法读取额度", "This account cannot read quota information.")
          )}
          {(!quota || quota.state === "unknown") && text(
            "额度状态未知，自动认领已暂停",
            "Quota status is unknown. Auto-claim is paused.",
          )}
        </div>
      )}
      <div className="project-automation-field">
        <span>{text("间隔", "Interval")}</span>
        <TaskPropertyPicker
          value={String(draft.intervalMinutes)}
          options={[5, 10, 15, 30, 60].map((minutes) => ({
            value: String(minutes),
            label: text(`${minutes} 分钟`, `${minutes} min`),
            icon: <RecurrenceIcon color="currentColor" size={14} />,
          }))}
          open={pickerMenu === "interval"}
          disabled={disabled}
          className="project-automation-picker"
          triggerClassName="project-automation-picker-trigger"
          ariaLabel={text("间隔", "Interval")}
          onOpenChange={(open) => setPickerMenu(open ? "interval" : null)}
          onChange={(value) => submitChange({
            ...draft,
            intervalMinutes: Number(value) as IntervalMinutes,
          })}
        />
      </div>
      {paseoMode && paseoDefaults && (
        <div className="project-automation-defaults">
          <div>
            <strong>{text("默认执行配置", "Default execution")}</strong>
            {automation?.profile || automation?.workspacePath ? (
              <span title={automation.workspacePath ?? undefined}>{[
                automation.profile?.name ?? text("项目默认 Agent", "Project default Agent"),
                automation.profile?.thinkingOptionId ? `Thinking ${automation.profile.thinkingOptionId}` : null,
                automation.profile?.modeId ? `Mode ${automation.profile.modeId}` : null,
                automation.workspacePath
                  ? automation.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? automation.workspacePath
                  : text("执行时决定目录", "Directory chosen at execution"),
              ].filter(Boolean).join(" · ")}</span>
            ) : (
              <span>{text("未设置；任务自己的执行配置优先。", "Not set; task-level configuration takes priority.")}</span>
            )}
          </div>
          <button type="button" disabled={disabled} onClick={openDefaultConfiguration}>
            {automation?.profile || automation?.workspacePath
              ? text("修改默认配置", "Edit defaults")
              : text("设置默认配置", "Set defaults")}
          </button>
        </div>
      )}
      {!paseoMode && selectedModel && (
        <>
          <div className="project-automation-field">
            <span>{text("模型", "Model")}</span>
            <TaskPropertyPicker
              value={draft.model ?? selectedModel.slug}
              options={models.map((model) => ({
                value: model.slug,
                label: model.displayName,
                icon: <ProjectIcon color="currentColor" size={14} />,
              }))}
              open={pickerMenu === "model"}
              disabled={disabled}
              className="project-automation-picker"
              triggerClassName="project-automation-picker-trigger"
              ariaLabel={text("模型", "Model")}
              onOpenChange={(open) => setPickerMenu(open ? "model" : null)}
              onChange={(value) => {
                const model = models.find((candidate) => candidate.slug === value);
                if (!model) return;
                submitChange({
                  ...draft,
                  model: value,
                  reasoningEffort: model.supportedReasoningEfforts.includes(draft.reasoningEffort ?? "")
                    ? draft.reasoningEffort ?? model.defaultReasoningEffort
                    : model.defaultReasoningEffort,
                });
              }}
            />
          </div>
          <div className="project-automation-field">
            <span>{text("推理强度", "Reasoning effort")}</span>
            <TaskPropertyPicker
              value={draft.reasoningEffort ?? selectedModel.defaultReasoningEffort}
              options={selectedModel.supportedReasoningEfforts.map((effort) => ({
                value: effort,
                label: EFFORT_LABELS[effort] ? text(...EFFORT_LABELS[effort]) : effort,
                icon: <LinearIcon name="displayOptions" />,
              }))}
              open={pickerMenu === "reasoning"}
              disabled={disabled}
              className="project-automation-picker"
              triggerClassName="project-automation-picker-trigger"
              ariaLabel={text("推理强度", "Reasoning effort")}
              onOpenChange={(open) => setPickerMenu(open ? "reasoning" : null)}
              onChange={(value) => submitChange({
                ...draft,
                reasoningEffort: value,
              })}
            />
          </div>
        </>
      )}
      {paseoMode && automation?.lastRunAt && (
        <p className="project-automation-note">
          {text(
            `上次检查：${new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(automation.lastRunAt))}`,
            `Last checked: ${new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(automation.lastRunAt))}`,
          )}
        </p>
      )}
      {paseoMode && automation?.lastError && <p className="project-automation-error" role="alert">{automation.lastError}</p>}
      {unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
      {error && error !== unavailableReason && <p className="project-automation-error" role="alert">{error}</p>}
    </div>,
    document.body,
  ) : null;

  const defaultsDialog = defaultsOpen && paseoDefaults ? (
    <PaseoProjectDefaultsDialog
      title={text("默认执行配置", "Default execution configuration")}
      description={text(
        "手动开始和自动认领共用；任务自己的执行配置优先。",
        "Shared by manual start and auto-claim; task-level settings take priority.",
      )}
      value={{
        profile: automation?.profile ?? null,
        workspacePath: automation?.workspacePath ?? null,
      }}
      catalog={paseoDefaults}
      onClose={() => setDefaultsOpen(false)}
      onSave={(value) => onSaveDefaults
        ? onSaveDefaults(value)
        : onChange({
            enabledByUser: automation?.enabledByUser ?? false,
            quotaAware: automation?.quotaAware ?? false,
            intervalMinutes: automation?.intervalMinutes ?? 5,
            workspacePath: value.workspacePath,
            profile: value.profile,
          })}
    />
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${status === "ACTIVE" ? "is-active" : "is-paused"}`}
        aria-label={status === "ACTIVE"
          ? text("自动认领中", "Auto-claiming")
          : text("自动化", "Automation")}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={status === "ACTIVE"
          ? text("自动认领中", "Auto-claiming")
          : text("自动化", "Automation")}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <TaskboardIcon name={status === "ACTIVE" ? "automationPause" : "automationPlay"} />
        <span>{status === "ACTIVE"
          ? text("自动认领中", "Auto-claiming")
          : text("自动化", "Automation")}</span>
      </button>
      {menu}
      {defaultsDialog}
    </>
  );
}

function formatResetTime(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1_000));
}
