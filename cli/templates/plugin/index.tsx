import type { Kernel } from "@kernel";

/**
 * Called once when the plugin loads. Other plugins import this module's named exports
 * as `plugin:{{id}}`.
 */
export default function activate(kernel: Kernel): void {
  kernel.log.info("{{id}} activated");
}
