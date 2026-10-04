import { isSubmenu, type MenuGroup, type MenuItem } from "./api.js";

export interface Ranked {
  readonly item: MenuItem;
  readonly rank: number;
}

interface Slot {
  readonly rank: number;
  readonly place: number;
  readonly item?: MenuItem;
  readonly group?: Branch;
}

interface Branch {
  readonly group: MenuGroup;
  readonly slots: Slot[];
}

export const GROUP_ID_PREFIX = "group:";

function lineage(id: string, groups: ReadonlyMap<string, MenuGroup>): MenuGroup[] {
  const found: MenuGroup[] = [];
  const seen = new Set<string>();
  let at = groups.get(id);
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    found.unshift(at);
    at = at.parent === undefined ? undefined : groups.get(at.parent);
  }
  return found;
}

export function nest(entries: readonly Ranked[], groups: ReadonlyMap<string, MenuGroup>): MenuItem[] {
  const root: Slot[] = [];
  const branches = new Map<string, Branch>();
  let place = 0;

  const branchFor = (chain: readonly MenuGroup[], rank: number): Slot[] => {
    let slots = root;
    for (const group of chain) {
      let branch = branches.get(group.id);
      if (!branch) {
        branch = { group, slots: [] };
        branches.set(group.id, branch);
        slots.push({ rank: group.order ?? rank, place: place++, group: branch });
      }
      slots = branch.slots;
    }
    return slots;
  };

  const ordered = entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  for (const { item, rank } of ordered) {
    const chain = item.group === undefined ? [] : lineage(item.group, groups);
    branchFor(chain, rank).push({ rank, place: place++, item });
  }
  return settle(root, groups);
}

function settle(slots: readonly Slot[], groups: ReadonlyMap<string, MenuGroup>): MenuItem[] {
  const items: MenuItem[] = [];
  for (const slot of [...slots].sort((a, b) => a.rank - b.rank || a.place - b.place)) {
    if (slot.item) {
      if (!isSubmenu(slot.item)) items.push(slot.item);
      else if (slot.item.items.length > 0) items.push(nestWithin(slot.item, groups));
      continue;
    }
    if (!slot.group) continue;
    const children = settle(slot.group.slots, groups);
    if (children.length === 0) continue;
    const { group } = slot.group;
    items.push({
      id: `${GROUP_ID_PREFIX}${group.id}`,
      label: group.label,
      ...(group.icon !== undefined ? { icon: group.icon } : {}),
      items: children,
    });
  }
  return items;
}

function nestWithin(submenu: MenuItem & { readonly items: readonly MenuItem[] }, groups: ReadonlyMap<string, MenuGroup>): MenuItem {
  const items = nest(
    submenu.items.map((item, rank) => ({ item, rank })),
    groups,
  );
  return { ...submenu, items };
}

export function nestItems(items: readonly MenuItem[], groups: ReadonlyMap<string, MenuGroup>): MenuItem[] {
  return nest(
    items.map((item, rank) => ({ item, rank })),
    groups,
  );
}
