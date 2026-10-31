// Injected into preview pages: hover outline + click-to-select, reports to dashboard via postMessage.
(function () {
  if (window.__clonerPicker) return;
  window.__clonerPicker = true;

  let selected = null;
  let hoverBox = null;
  let selectBox = null;
  let armed = false;

  function box(color) {
    const d = document.createElement("div");
    d.style.cssText = `position:absolute;pointer-events:none;z-index:2147483647;outline:2px solid ${color};outline-offset:-1px;background:${color}14;transition:all .05s`;
    document.documentElement.appendChild(d);
    return d;
  }
  function rect(el) {
    const r = el.getBoundingClientRect();
    return { left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height };
  }
  function move(d, el) {
    const r = rect(el);
    Object.assign(d.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", display: r.width && r.height ? "block" : "none" });
  }
  function selectorFor(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
      if (node.className && typeof node.className === "string") {
        const c = node.className.trim().split(/\s+/).slice(0, 2).map((x) => "." + CSS.escape(x)).join("");
        part += c;
      }
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((ch) => ch.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  window.addEventListener("mousemove", (e) => {
    if (!armed) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hoverBox || el === selectBox) return;
    if (!hoverBox) hoverBox = box("#f59e0b");
    move(hoverBox, el);
    hoverBox.__target = el;
  }, true);

  window.addEventListener("click", (e) => {
    if (!armed) return;
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hoverBox) return;
    selected = el;
    if (!selectBox) selectBox = box("#22d3ee");
    move(selectBox, el);
    hoverBox && (hoverBox.style.display = "none");
    parent.postMessage({
      type: "cloner:pick",
      selector: selectorFor(el),
      info: {
        tag: el.tagName.toLowerCase(),
        classes: typeof el.className === "string" ? el.className.slice(0, 200) : "",
        text: (el.innerText || el.textContent || "").trim().slice(0, 300),
        outerHTML: el.outerHTML.slice(0, 4000),
        styles: (() => { const c = getComputedStyle(el); return { color: c.color, background: c.backgroundColor, fontSize: c.fontSize, fontWeight: c.fontWeight, padding: c.padding, borderRadius: c.borderRadius }; })(),
      },
    }, "*");
  }, true);

  // block real navigation while armed
  window.addEventListener("submit", (e) => armed && e.preventDefault(), true);

  window.addEventListener("message", (e) => {
    if (e.data?.type === "cloner:arm") {
      armed = e.data.armed;
      document.documentElement.style.cursor = armed ? "crosshair" : "";
      if (!armed && hoverBox) hoverBox.style.display = "none";
      if (armed) { hoverBox = null; }
    }
    if (e.data?.type === "cloner:deselect" && selectBox) selectBox.style.display = "none";
  });

  parent.postMessage({ type: "cloner:ready" }, "*");
})();
