// The pages clipped into the Projects divider, in order. Adding a project is one entry
// here plus its page component in ProjectsSheet.astro; the pager, the "Page n of N"
// label, the stacked paper edges and the folder's expansion scores all follow.
export const PROJECTS = [{ id: "lazaret", title: "Lazaret" }] as const;
export const PROJECT_PAGES = PROJECTS.length;
