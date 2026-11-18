const isImageAttachment = file => !file.link && /\.(png|jpe?g|webp|gif)$/i.test(file.name);

function openImagePreview(taskId, files, initialIndex, initialSrc, source = {
  preview: file => api.attachmentPreview(taskId, file.file),
  save: file => api.saveAttachment(taskId, file.file, file.name),
}) {
  const dialog = element("dialog", undefined, "image-preview");
  const header = element("header", undefined, "image-preview-header");
  const toolbar = element("footer", undefined, "image-preview-toolbar");
  const title = element("strong");
  const viewport = element("div", undefined, "image-preview-viewport");
  viewport.tabIndex = 0;
  viewport.setAttribute("autofocus", "");
  bindLocalized(viewport, "aria-label", () => t("ui.image_0ef98c9b"), true);
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

  const zoomOut = button("", () => zoom(1 / 1.25), "quiet");
  zoomOut.append(icon("zoom-out"));
  controlLabelForIcon(zoomOut, () => t("ui.zoom_out_f212b60f"));
  const zoomIn = button("", () => zoom(1.25), "quiet");
  zoomIn.append(icon("zoom-in"));
  controlLabelForIcon(zoomIn, () => t("ui.zoom_in_ee912b88"));
  const close = button("", () => dialog.close(), "quiet");
  close.append(icon("close"));
  controlLabelForIcon(close, () => t("ui.close_preview_c54f8606"));
  const original = button("1:1", () => { fitted = false; resize(1); }, "quiet");
  controlLabelForIcon(original, () => t("ui.actual_size_bff05f3a"));
  const save = button(() => t("ui.save_7eea8139"), async () => {
    const file = files[displayedIndex];
    const selection = request;
    const result = await source.save(file);
    if (!result.ok && dialog.open && selection === request && file === files[displayedIndex]) {
      status.textContent = boardError(result.error);
      status.hidden = false;
    }
  }, "quiet");
  const move = delta => show((index + delta + files.length) % files.length);
  header.append(title);
  const navigation = [];
  if (files.length > 1) {
    const previous = button("", () => move(-1), "quiet");
    previous.append(icon("arrow-left"));
    previous.classList.add("image-preview-previous");
    const next = button("", () => move(1), "quiet");
    next.append(icon("arrow-right"));
    next.classList.add("image-preview-next");
    controlLabelForIcon(previous, () => t("ui.previous_image_4a7f8790"));
    controlLabelForIcon(next, () => t("ui.next_image_d867f6ec"));
    header.append(position);
    navigation.push(previous, next);
    dialog.addEventListener("keydown", event => {
      if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      move(event.key === "ArrowLeft" ? -1 : 1);
    });
  }
  header.append(close);
  toolbar.append(zoomOut, scaleLabel, zoomIn, button(() => t("ui.fit_9a002f36"), fit, "quiet"), original, save);
  stage.append(image);
  viewport.append(stage);
  dialog.append(header, viewport, status, ...navigation, toolbar);

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
        bindLocalized(status, "textContent", () => t("ui.image_unavailable_024abc1d") + files[at].name);
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
      bindLocalized(status, "textContent", () => t("ui.loading_image_2f7fd2f5"));
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
