import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

/**
 * `PluginSurfaceProps` inlines `layout`/`navigation` rather than exporting
 * named types for them (confirmed against the installed 0.8.0
 * `@getpaseo/plugin` declarations). Derive local aliases instead of
 * guessing at names that don't exist in this SDK version.
 */
export type PluginLayout = PluginSurfaceProps["layout"];
export type PluginNavigation = PluginSurfaceProps["navigation"];
