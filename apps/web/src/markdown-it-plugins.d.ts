// markdown-it-mark ships no type declarations; its default export is a
// standard markdown-it plugin.
declare module "markdown-it-mark" {
  import type { PluginSimple } from "markdown-it";
  const plugin: PluginSimple;
  export default plugin;
}
