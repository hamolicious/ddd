import type { Kernel } from "@kernel";

export default function activate(kernel: Kernel): void {
  kernel.log.info("{{id}} activated");
}
