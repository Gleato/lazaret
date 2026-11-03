// Before first paint: a deep link (#projects) shows the folder already open, so it
// doesn't flash shut while folder-ui.ts loads; that module takes over from here.
// Folder.astro inlines this file verbatim right after the folder, and astro.config.mjs
// hashes the same file into the CSP, so the policy always allows exactly this script.
(() => {
  const f = document.currentScript?.previousElementSibling;
  const tab = location.hash.slice(1).toLowerCase();
  if (!f || !["profile", "projects", "experience"].includes(tab)) return;
  f.dataset.state = "open";
  f.dataset.active = tab;
  for (const s of f.querySelectorAll("[data-sheet]")) s.hidden = s.dataset.sheet !== tab;
  for (const t of f.querySelectorAll("[data-tab]")) {
    t.setAttribute("aria-selected", String(t.dataset.tab === tab));
  }
})();
