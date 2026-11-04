/**
 * Connector plugins (server-only): out-of-process connectors that speak My Graph's plugin protocol (JSON lines over
 * stdio: spec, check, discover, read with RECORD / STATE / LOG / TRACE), installed by the platform admin in the plugin
 * directory and run as a "plugin" connection. See docs/plugins/README.md.
 */
export { pluginConnector, pluginManifest, type PluginConfig } from "./connector";
export { installedPlugins, installedPlugin, pluginsDir, type InstalledPlugin } from "./manifest";
export { runPlugin, collect, PluginRunError, DEFAULT_LIMITS, type RunLimits } from "./runner";
export * from "./protocol";
