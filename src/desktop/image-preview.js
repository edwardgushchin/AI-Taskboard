const isImageAttachment = file => /\.(png|jpe?g|webp|gif)$/i.test(file.name);

function openImagePreview(src, name, save) {
  const dialog = element("dialog", undefined, "image-preview");
  dialog.setAttribute("aria-label", name);
  const toolbar = element("header", undefined, "image-preview-toolbar");
  const title = element("strong", name);
  title.title = name;
  const viewport = element("div", undefined, "image-preview-viewport");
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", language("Image", "Изображение"));
  const stage = element("div", undefined, "image-preview-stage");
  const image = element("img");
  image.alt = name;
  image.draggable = false;
  const scaleLabel = element("output");
  let scale = 1;
  let fitted = true;
  let drag;

  function resize(next, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
    if (!image.naturalWidth) return;
    const before = image.getBoundingClientRect();
    const origin = viewport.getBoundingClientRect();
    const imageX = (origin.left + x - before.left) / scale;
    const imageY = (origin.top + y - before.top) / scale;
    scale = next;
    image.style.width = image.naturalWidth * scale + "px";
    image.style.height = image.naturalHeight * scale + "px";
    const after = image.getBoundingClientRect();
    viewport.scrollBy(after.left + imageX * scale - origin.left - x, after.top + imageY * scale - origin.top - y);
    scaleLabel.value = Math.round(scale * 100) + "%";
  }

  function fit() {
    if (!image.naturalWidth) return;
    fitted = true;
    resize(Math.min(1, viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight));
  }

  function zoom(factor, x, y) {
    fitted = false;
    const minimum = Math.min(scale, .05);
    resize(Math.min(16, Math.max(minimum, scale * factor)), x, y);
  }

  const zoomOut = button("−", () => zoom(1 / 1.25), "quiet");
  controlLabelForIcon(zoomOut, language("Zoom out", "Уменьшить"));
  const zoomIn = button("+", () => zoom(1.25), "quiet");
  controlLabelForIcon(zoomIn, language("Zoom in", "Увеличить"));
  const close = button("×", () => dialog.close(), "quiet");
  controlLabelForIcon(close, language("Close preview", "Закрыть просмотр"));
  const original = button("1:1", () => { fitted = false; resize(1); }, "quiet");
  controlLabelForIcon(original, language("Actual size", "Исходный размер"));
  toolbar.append(title, zoomOut, scaleLabel, zoomIn, button(language("Fit", "Вписать"), fit, "quiet"),
    original, button(language("Save", "Сохранить"), save, "quiet"), close);
  stage.append(image);
  viewport.append(stage);
  dialog.append(toolbar, viewport);

  viewport.addEventListener("wheel", event => {
    event.preventDefault();
    if (!event.deltaY) return;
    const bounds = viewport.getBoundingClientRect();
    zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX - bounds.left, event.clientY - bounds.top);
  }, { passive: false });
  viewport.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    drag = { x: event.clientX + viewport.scrollLeft, y: event.clientY + viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("dragging");
  });
  viewport.addEventListener("pointermove", event => {
    if (drag) viewport.scrollTo(drag.x - event.clientX, drag.y - event.clientY);
  });
  viewport.addEventListener("lostpointercapture", () => {
    drag = undefined;
    viewport.classList.remove("dragging");
  });
  const observer = new ResizeObserver(() => { if (fitted) fit(); });
  dialog.addEventListener("close", () => { observer.disconnect(); dialog.remove(); });
  image.addEventListener("load", fit, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  observer.observe(viewport);
  image.src = src;
}
