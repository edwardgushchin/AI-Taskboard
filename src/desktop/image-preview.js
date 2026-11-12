const isImageAttachment = file => /\.(png|jpe?g|webp|gif)$/i.test(file.name);

function openImagePreview(taskId, files, initialIndex, initialSrc, source = {
  preview: file => api.attachmentPreview(taskId, file.file),
  save: file => api.saveAttachment(taskId, file.file, file.name),
}) {
  const dialog = element("dialog", undefined, "image-preview");
  const toolbar = element("header", undefined, "image-preview-toolbar");
  const title = element("strong");
  const viewport = element("div", undefined, "image-preview-viewport");
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", language("Image", "Изображение"));
  const stage = element("div", undefined, "image-preview-stage");
  let image = element("img");
  image.hidden = true;
  const scaleLabel = element("output");
  const position = element("output");
  const status = element("p", undefined, "image-preview-status");
  status.setAttribute("role", "status");
  let index = initialIndex;
  let displayedIndex = initialIndex;
  let request = 0;
  const cache = new Map();
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
    const file = files[displayedIndex];
    const selection = request;
    const result = await source.save(file);
    if (!result.ok && dialog.open && selection === request && file === files[displayedIndex]) {
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
  dialog.addEventListener("close", () => { request++; cache.clear(); observer.disconnect(); dialog.remove(); });

  function load(at, cached) {
    if (cache.has(at)) return cache.get(at);
    const entry = { image: null, pending: null };
    cache.set(at, entry);
    entry.pending = (async () => {
      try {
        const src = cached ?? await source.preview(files[at]);
        if (!src || !dialog.open) return null;
        const loaded = element("img");
        loaded.draggable = false;
        loaded.alt = files[at].name;
        loaded.src = src;
        // Decode off screen so a ready element can replace the current image in one paint.
        await loaded.decode();
        if (!dialog.open) return null;
        entry.image = loaded;
        return loaded;
      } catch {
        return null;
      }
    })();
    return entry;
  }

  function describe(at) {
    const file = files[at];
    const label = file.name;
    title.textContent = title.title = label;
    dialog.setAttribute("aria-label", label);
    position.value = (at + 1) + " / " + files.length;
  }

  function show(at, cached) {
    const selection = ++request;
    index = at;
    const entry = load(at, cached);
    const display = loaded => {
      if (selection !== request || !dialog.open) return;
      if (!loaded) {
        status.textContent = language("Image unavailable: ", "Изображение недоступно: ") + files[at].name;
        status.hidden = false;
        return;
      }
      if (loaded !== image) {
        image.replaceWith(loaded);
        image = loaded;
        image.removeAttribute("style");
        scale = 1;
        fitted = true;
        viewport.scrollTo(0, 0);
        fit();
      }
      displayedIndex = at;
      describe(at);
      status.hidden = true;
      save.disabled = false;
    };
    if (entry.image) display(entry.image);
    else {
      status.textContent = language("Loading image…", "Загрузка изображения…");
      status.hidden = false;
      void entry.pending.then(display);
    }
    if (files.length > 1) {
      load((at + 1) % files.length);
      load((at - 1 + files.length) % files.length);
    }
  }
  describe(initialIndex);
  scaleLabel.value = "—";
  save.disabled = true;
  document.body.append(dialog);
  dialog.showModal();
  observer.observe(viewport);
  void show(initialIndex, initialSrc);
}
