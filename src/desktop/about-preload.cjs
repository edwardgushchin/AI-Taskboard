const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("copy").addEventListener("click", () => ipcRenderer.send("about:copy"));
  document.getElementById("close").addEventListener("click", () => ipcRenderer.send("about:close"));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      ipcRenderer.send("about:close");
    }
  });
});
