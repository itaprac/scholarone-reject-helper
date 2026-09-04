// Layout switcher shared by Desk, Ledger and the classic panel.
//
// The page sets <html data-layout="desk|ledger|classic">. Visiting a layout
// makes it the default that "/" redirects to next time (see index.html).

window.S1Switch = (() => {
  const KEY = "s1.layout";
  const LAYOUTS = [
    { id: "desk", label: "Desk", href: "/desk.html" },
    { id: "ledger", label: "Ledger", href: "/ledger.html" },
    { id: "classic", label: "Classic", href: "/index.html?layout=classic" },
  ];
  const current = document.documentElement.dataset.layout || "classic";

  try {
    localStorage.setItem(KEY, current);
  } catch {
    // Private mode or blocked storage: the switcher still works, only the default is lost.
  }

  const nav = document.createElement("nav");
  nav.className = "layout-switch";
  nav.setAttribute("aria-label", "Layout");
  for (const layout of LAYOUTS) {
    const link = document.createElement("a");
    link.href = layout.href;
    link.textContent = layout.label;
    if (layout.id === current) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  document.addEventListener("DOMContentLoaded", () => document.body.append(nav));

  return {
    current,
    // Desk raises the pill above its bottom dock.
    setOffset(px) {
      nav.style.bottom = `${px}px`;
    },
  };
})();
