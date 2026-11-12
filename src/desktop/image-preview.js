const isImageAttachment = file => /\.(png|jpe?g|webp|gif)$/i.test(file.name);

function openImagePreview(taskId, files, initialIndex, initialSrc) {
  const dialog = element("dialog", undefined, "image-preview");
  const toolbar = element("header", undefined, "image-preview-toolbar");
  const title = element("strong");
  const viewport = element("div", undefined, "image-preview-viewport");
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", language("Image", "Изображение"));
  const stage = element("div", undefined, "image-preview-stage");
  const image = element("img");
  image.draggable = false;
  const scaleLabel = element("output");
  const position = element("output");
  const status = element("p", undefined, "image-preview-status");
  status.setAttribute("role", "status");
  let index = initialIndex;
  let request = 0;
  let scale = 1;
  let fitted = true;
  let drag;

  function resize(next, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
    if (image.hidden || !image.naturalWidth) return;
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
  const save = button(language("Save", "Сохранить"), async () => {
    const file = files[index];
    const selection = request;
    const result = await api.saveAttachment(taskId, file.file, file.name);
    if (!result.ok && dialog.open && selection === request) {
      status.textContent = boardError(result.error);
      status.hidden = false;
    }
  }, "quiet");
  const move = delta => show((index + delta + files.length) % files.length);
  toolbar.append(title);
  if (files.length > 1) {
    const previous = button("←", () => move(-1), "quiet");
    const next = button("→", () => move(1), "quiet");
    controlLabelForIcon(previous, language("Previous image", "Предыдущее изображение"));
    controlLabelForIcon(next, language("Next image", "Следующее изображение"));
    toolbar.append(previous, position, next);
    dialog.addEventListener("keydown", event => {
      if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      move(event.key === "ArrowLeft" ? -1 : 1);
    });
  }
  toolbar.append(zoomOut, scaleLabel, zoomIn, button(language("Fit", "Вписать"), fit, "quiet"), original, save, close);
  stage.append(image, status);
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
  dialog.addEventListener("close", () => { request++; observer.disconnect(); dialog.remove(); });
  async function show(at, cached) {
    const selection = ++request;
    index = at;
    const file = files[at];
    const label = file.name;
    title.textContent = title.title = image.alt = label;
    dialog.setAttribute("aria-label", label);
    position.value = (at + 1) + " / " + files.length;
    image.hidden = true;
    image.removeAttribute("src");
    image.removeAttribute("style");
    scale = 1;
    scaleLabel.value = "—";
    fitted = true;
    viewport.scrollTo(0, 0);
    status.hidden = false;
    status.textContent = language("Loading image…", "Загрузка изображения…");
    const unavailable = () => {
      if (selection === request) status.textContent = language("Image unavailable.", "Изображение недоступно.");
    };
    const src = cached ?? await api.attachmentPreview(taskId, file.file).catch(() => null);
    if (selection !== request || !dialog.open) return;
    if (!src) return unavailable();
    image.onerror = unavailable;
    image.onload = () => {
      if (selection !== request) return;
      image.hidden = false;
      status.hidden = true;
      fit();
    };
    image.src = src;
  }
  document.body.append(dialog);
  dialog.showModal();
  observer.observe(viewport);
  void show(initialIndex, initialSrc);
}
