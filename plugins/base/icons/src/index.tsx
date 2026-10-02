import type { IconInfo } from "./api.js";
import { drawingNow, loadDrawing, loadIndex } from "./data.js";
import { searchIcons } from "./search.js";

export type { IconInfo, IconPickerProps, IconProps, Icons } from "./api.js";
export { Icon } from "./Icon.js";
export { Picker } from "./Picker.js";

export async function search(query: string, limit?: number): Promise<readonly IconInfo[]> {
  return searchIcons(await loadIndex(), query, limit);
}

export async function has(name: string): Promise<boolean> {
  await loadDrawing(name);
  return drawingNow(name) !== undefined;
}

export default function activate(): void {}
