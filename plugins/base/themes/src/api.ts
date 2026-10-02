import { createRegistry, s } from "@kernel";

export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly scheme: "light" | "dark";
  readonly tokens: Readonly<Record<string, string>>;
}

export const themeRegistry = createRegistry<Theme>({
  key: (theme) => theme.id,
  shape: s.object({
    id: s.string(),
    name: s.string(),
    scheme: s.literal("light", "dark"),
    tokens: s.record(s.string()),
  }),
});
