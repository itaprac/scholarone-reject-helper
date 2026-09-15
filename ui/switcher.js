// Layout switcher shared by Desk, Ledger and the classic panel.
//
// The page sets <html data-layout="desk|ledger|classic">. Visiting a layout
// selects that layout for this visit. "/" always opens Ledger.

window.S1Switch = (() => {
  const LAYOUTS = [
    { id: "desk", label: "Desk", href: "/desk.html" },
    { id: "ledger", label: "Ledger", href: "/ledger.html" },
    { id: "classic", label: "Classic", href: "/index.html?layout=classic" },
  ];
  const current = document.documentElement.dataset.layout || "classic";

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
