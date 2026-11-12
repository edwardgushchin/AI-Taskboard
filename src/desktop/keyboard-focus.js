// Text fields match :focus-visible after a mouse click, too.
document.addEventListener("keydown", event => {
  if (event.key === "Tab" || ((event.ctrlKey || event.metaKey) && event.code === "KeyF")) {
    document.documentElement.dataset.keyboardFocus = "";
  }
}, true);

document.addEventListener("pointerdown", () => {
  delete document.documentElement.dataset.keyboardFocus;
}, true);
