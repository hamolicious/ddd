declare module "virtual:ddd-precache" {
  export const precacheEntries: readonly { readonly url: string; readonly revision: string | null }[];
}
