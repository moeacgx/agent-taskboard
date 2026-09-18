import { useEffect, useMemo, useState } from "react";

import type {
  PaseoConfigurationOptions,
  PaseoConfigurationOptionsRequest,
} from "../paseo-bridge";

export interface PaseoConfigurationSelection {
  modeId?: string;
  thinkingOptionId?: string;
}

interface PaseoConfigurationFieldsProps {
  target: PaseoConfigurationOptionsRequest | null;
  loadOptions: (target: PaseoConfigurationOptionsRequest) => Promise<PaseoConfigurationOptions>;
  onSelectionChange?: (selection: PaseoConfigurationSelection) => void;
  onReadyChange?: (ready: boolean) => void;
  onSave?: (selection: PaseoConfigurationSelection) => Promise<void>;
  onOpenAgent?: () => void;
  variant: "editor" | "detail";
}

function supportedValue(
  choices: PaseoConfigurationOptions["modes"],
  current: string | undefined,
  fallback: string | undefined,
): string {
  if (current && choices.some((choice) => choice.id === current)) return current;
  if (current && choices.length === 0) return current;
  if (fallback && choices.some((choice) => choice.id === fallback)) return fallback;
  return "";
}

export function PaseoConfigurationFields({
  target,
  loadOptions,
  onSelectionChange,
  onReadyChange,
  onSave,
  onOpenAgent,
  variant,
}: PaseoConfigurationFieldsProps) {
  const [options, setOptions] = useState<PaseoConfigurationOptions | null>(null);
  const [modeId, setModeId] = useState("");
  const [thinkingOptionId, setThinkingOptionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadSequence, setReloadSequence] = useState(0);
  const targetKey = target
    ? [target.provider, target.model, target.workspacePath, target.agentId ?? ""].join("\u0000")
    : "";

  useEffect(() => {
    let active = true;
    setOptions(null);
    setModeId("");
    setThinkingOptionId("");
    setError(null);
    onReadyChange?.(false);
    onSelectionChange?.({});
    if (!target) return () => { active = false; };

    setLoading(true);
    void loadOptions(target).then((next) => {
      if (!active) return;
      const nextModeId = supportedValue(next.modes, next.currentModeId, next.defaultModeId);
      const nextThinkingOptionId = supportedValue(
        next.thinkingOptions,
        next.currentThinkingOptionId,
        next.defaultThinkingOptionId,
      );
      setOptions(next);
      setModeId(nextModeId);
      setThinkingOptionId(nextThinkingOptionId);
      onSelectionChange?.({
        ...(nextModeId ? { modeId: nextModeId } : {}),
        ...(nextThinkingOptionId ? { thinkingOptionId: nextThinkingOptionId } : {}),
      });
      onReadyChange?.(true);
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [loadOptions, reloadSequence, targetKey]);

  const editable = options?.editable === true && Boolean(onSave || onSelectionChange);
  const fields = useMemo(() => [
    {
      key: "thinking" as const,
      label: "Thinking",
      value: thinkingOptionId,
      choices: options?.thinkingOptions ?? [],
    },
    {
      key: "mode" as const,
      label: "Mode",
      value: modeId,
      choices: options?.modes ?? [],
    },
  ], [modeId, options, thinkingOptionId]);

  async function changeValue(kind: "thinking" | "mode", value: string) {
    const previous = { modeId, thinkingOptionId };
    const next = {
      modeId: kind === "mode" ? value : modeId,
      thinkingOptionId: kind === "thinking" ? value : thinkingOptionId,
    };
    setModeId(next.modeId);
    setThinkingOptionId(next.thinkingOptionId);
    const selection = {
      ...(next.modeId ? { modeId: next.modeId } : {}),
      ...(next.thinkingOptionId ? { thinkingOptionId: next.thinkingOptionId } : {}),
    };
    onSelectionChange?.(selection);
    if (!onSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(selection);
    } catch (caught) {
      setModeId(previous.modeId);
      setThinkingOptionId(previous.thinkingOptionId);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  if (!target) return null;

  return (
    <div className={`paseo-configuration-fields is-${variant}`}>
      {fields.map((field) => {
        const unsupported = !loading && options !== null && field.choices.length === 0;
        const selected = field.choices.find((choice) => choice.id === field.value);
        const unsupportedMode = unsupported && field.key === "mode";
        const currentWithoutCatalog = unsupported && field.value
          ? field.value
          : null;
        return (
          <label className="paseo-configuration-row" key={field.key}>
            <span>{field.label}</span>
            <select
              value={field.value}
              disabled={!editable || loading || saving || unsupported}
              aria-label={field.label}
              title={selected?.description ?? (unsupportedMode
                ? "当前 Paseo 集成未提供可切换的模式"
                : undefined)}
              onChange={(event) => void changeValue(field.key, event.target.value)}
            >
              <option value="">
                {unsupportedMode
                  ? "使用默认模式"
                  : unsupported
                    ? "不支持"
                    : loading
                      ? "加载中…"
                      : "默认"}
              </option>
              {currentWithoutCatalog && (
                <option value={currentWithoutCatalog}>{currentWithoutCatalog}（当前）</option>
              )}
              {field.choices.map((choice) => (
                <option value={choice.id} key={choice.id}>{choice.label}</option>
              ))}
            </select>
            {variant === "detail" && unsupportedMode && (
              <small className="paseo-configuration-inline-note">
                当前 Paseo 集成未提供可切换的模式
              </small>
            )}
          </label>
        );
      })}
      {variant === "editor" && options && options.modes.length === 0 && (
        <div className="paseo-configuration-message is-capability-note">
          <span>当前 Paseo 集成未提供可切换的模式</span>
        </div>
      )}
      {error && (
        <div className="paseo-configuration-message" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setReloadSequence((value) => value + 1)}>重试</button>
        </div>
      )}
      {options && !options.editable && (
        <div className="paseo-configuration-message">
          <span>已有会话需在 Paseo 中调整</span>
          {onOpenAgent && <button type="button" onClick={onOpenAgent}>打开 Paseo</button>}
        </div>
      )}
    </div>
  );
}
