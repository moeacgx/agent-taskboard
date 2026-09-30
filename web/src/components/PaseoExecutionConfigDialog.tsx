import { useState } from "react";
import { createPortal } from "react-dom";

import { useTaskboardI18n } from "../i18n";
import type {
  PaseoConfigurationOptions,
  PaseoConfigurationOptionsRequest,
} from "../paseo-bridge";
import { LinearIcon } from "./LinearIcon";
import {
  PaseoAssigneePicker,
  type PaseoAssigneeOption,
} from "./PaseoAssigneePicker";
import {
  PaseoConfigurationFields,
  type PaseoConfigurationSelection,
} from "./PaseoConfigurationFields";

interface PaseoExecutionConfigDialogProps {
  taskIdentifier: string;
  options: PaseoAssigneeOption[];
  loading: boolean;
  error: string | null;
  initialChoiceId: string;
  initialWorkspacePath: string | null;
  initialModeId?: string;
  initialThinkingOptionId?: string;
  onRefresh: () => void;
  loadOptions: (target: PaseoConfigurationOptionsRequest) => Promise<PaseoConfigurationOptions>;
  onCancel: () => void;
  onSave: (
    choiceId: string,
    workspacePath: string | null,
    selection: PaseoConfigurationSelection,
  ) => Promise<void>;
}

export function PaseoExecutionConfigDialog({
  taskIdentifier,
  options,
  loading,
  error,
  initialChoiceId,
  initialWorkspacePath,
  initialModeId,
  initialThinkingOptionId,
  onRefresh,
  loadOptions,
  onCancel,
  onSave,
}: PaseoExecutionConfigDialogProps) {
  const { text } = useTaskboardI18n();
  const [choiceId, setChoiceId] = useState(initialChoiceId);
  const [configuration, setConfiguration] = useState<PaseoConfigurationSelection>({});
  const [configurationSeed, setConfigurationSeed] = useState<PaseoConfigurationSelection>({
    ...(initialModeId ? { modeId: initialModeId } : {}),
    ...(initialThinkingOptionId ? { thinkingOptionId: initialThinkingOptionId } : {}),
  });
  const [configurationReady, setConfigurationReady] = useState(() => {
    const initial = options.find((option) => option.id === initialChoiceId);
    return !initial?.model;
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const selectedOption = options.find((option) => option.id === choiceId) ?? null;
  const target = selectedOption?.provider && selectedOption.model
    ? {
        provider: selectedOption.provider,
        model: selectedOption.model,
        workspacePath: initialWorkspacePath,
        ...(configurationSeed.modeId ? { modeId: configurationSeed.modeId } : {}),
        ...(configurationSeed.thinkingOptionId
          ? { thinkingOptionId: configurationSeed.thinkingOptionId }
          : {}),
      }
    : null;

  function resetConfiguration(option: PaseoAssigneeOption | null) {
    setConfiguration({});
    setConfigurationSeed({
      ...(option?.modeId ? { modeId: option.modeId } : {}),
      ...(option?.thinkingOptionId ? { thinkingOptionId: option.thinkingOptionId } : {}),
    });
    setConfigurationReady(!option?.model);
    setSaveError(null);
  }

  async function submit() {
    if (saving) return;
    if (!selectedOption) {
      setSaveError(text("请选择 Agent 配置。", "Select an Agent configuration."));
      return;
    }
    if (!configurationReady) {
      setSaveError(text(
        "正在读取 Thinking/Mode 选项，请稍后。",
        "Thinking/Mode options are still loading.",
      ));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(choiceId, initialWorkspacePath, configuration);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="delete-backdrop automation-defaults-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <div
        className="delete-dialog automation-defaults-dialog paseo-execution-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="paseo-execution-config-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onCancel();
        }}
      >
        <header>
          <div>
            <h2 id="paseo-execution-config-title">
              {initialChoiceId
                ? text("编辑执行配置", "Edit execution configuration")
                : text("配置执行", "Configure execution")}
            </h2>
            <p>{text(
              `${taskIdentifier} 仅保存 Agent 计划，不会启动任务。`,
              `This only saves the Agent plan for ${taskIdentifier}; it does not start the task.`,
            )}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={saving}
            aria-label={text("关闭", "Close")}
            onClick={onCancel}
          >
            <LinearIcon name="close" />
          </button>
        </header>
        <div className="automation-defaults-fields paseo-execution-fields">
          <div className="paseo-execution-field">
            <span>{text("Agent", "Agent")}</span>
            <PaseoAssigneePicker
              options={options}
              value={choiceId || null}
              loading={loading}
              error={error}
              onRefresh={onRefresh}
              onChange={(id) => {
                setChoiceId(id);
                resetConfiguration(options.find((option) => option.id === id) ?? null);
              }}
            />
          </div>
          {initialWorkspacePath && (
            <p className="paseo-execution-directory-note">
              {text("代码目录已在任务详情中设置", "Code directory is set in the task details")}
            </p>
          )}
          {target && (
            <PaseoConfigurationFields
              key={choiceId}
              target={target}
              loadOptions={loadOptions}
              onSelectionChange={setConfiguration}
              onReadyChange={setConfigurationReady}
              variant="editor"
            />
          )}
        </div>
        {saveError && <p className="project-automation-error" role="alert">{saveError}</p>}
        <div className="automation-defaults-actions paseo-execution-actions">
          <span />
          <button type="button" className="button secondary" disabled={saving} onClick={onCancel}>
            {text("取消", "Cancel")}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={saving || !selectedOption || !configurationReady}
            onClick={() => void submit()}
          >
            {saving ? text("保存中…", "Saving…") : text("保存执行配置", "Save execution configuration")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
