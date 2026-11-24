import localization from "../src/desktop/localization.cjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/desktop/image-preview.js", import.meta.url), "utf8");
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

// Control reads and image decoding independently; this fixture does not verify layout.
function preview(count = 5, initialSrc: string | null = "image-0") {
  const reads: string[] = [];
  const saves: string[] = [];
  const requests = new Map<string, ReturnType<typeof Promise.withResolvers<string | null>>>();
  const decodes = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const nodes: PreviewElement[] = [];
  function decoding(src: string) {
    if (!decodes.has(src)) decodes.set(src, Promise.withResolvers<void>());
    return decodes.get(src)!;
  }
  class PreviewElement {
    children: PreviewElement[] = [];
    parent?: PreviewElement;
    attributes = new Map<string, string>();
    events = new Map<string, (event?: any) => void>();
    style: Record<string, string> = {};
    hidden = false;
    disabled = false;
    open = false;
    popoverOpen = false;
    alt = "";
    textContent = "";
    value = "";
    naturalWidth = 0;
    naturalHeight = 0;
    clientWidth = 800;
    clientHeight = 600;
    source = "";
    onload?: () => void;
    onerror?: () => void;
    click?: () => unknown;
    classList = { add() {}, remove() {} };
    tag: string;
    className?: string;
    constructor(tag: string, className?: string) {
      this.tag = tag;
      this.className = className;
      nodes.push(this);
    }
    get src() { return this.source; }
    set src(value: string) {
      this.source = value;
      void decoding(value).promise.then(() => {
        this.naturalWidth = 960;
        this.naturalHeight = 560;
        this.onload?.();
      }, () => this.onerror?.());
    }
    decode() { return decoding(this.src).promise; }
    append(...children: PreviewElement[]) {
      children.forEach(child => { child.parent = this; this.children.push(child); });
    }
    replaceWith(next: PreviewElement) {
      const parent = this.parent!;
      parent.children[parent.children.indexOf(this)] = next;
      next.parent = parent;
      this.parent = undefined;
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = undefined;
    }
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    removeAttribute(key: string) {
      if (key === "style") this.style = {};
      if (key === "src") this.source = "";
    }
    addEventListener(name: string, listener: (event?: any) => void) { this.events.set(name, listener); }
    showModal() { this.open = true; }
    matches(selector: string) {
      assert.equal(selector, ":popover-open");
      return this.popoverOpen;
    }
    showPopover() { this.popoverOpen = true; }
    hidePopover() { this.popoverOpen = false; }
    close() { this.open = false; this.events.get("close")?.(); }
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    scrollBy() {}
    scrollTo() {}
  }
  const body = new PreviewElement("body");
  const files = Array.from({ length: count }, (_, index) => ({ name: "variant-" + index + ".png", file: String(index) }));
  const open = runInNewContext(source + ";openImagePreview", {
    document: { body },
    element: (tag: string, text?: string, className?: string) => {
      const node = new PreviewElement(tag, className);
      node.textContent = typeof text === "function" ? (text as () => string)() : text ?? "";
      return node;
    },
    button: (text: string, click: () => unknown) => {
      const node = new PreviewElement("button");
      node.textContent = typeof text === "function" ? (text as () => string)() : text;
      node.click = click;
      return node;
    },
    icon: () => new PreviewElement("i"),
    controlLabelForIcon: (node: PreviewElement, label: string) => node.setAttribute("aria-label", typeof label === "function" ? (label as () => string)() : label),
    t: (key: string, parameters = {}) => localization.text(key, parameters, "en"), localization, bindLocalized: (node: any, property: string, render: () => string, attribute = false) => { const value = render(); if (attribute) node.setAttribute(property, value); else node[property] = value; return value; },
    boardError: (error: Error) => error.message,
    ResizeObserver: class { observe() {} disconnect() {} },
    api: {
      attachmentPreview: (_task: string, file: string) => {
        reads.push(file);
        const request = Promise.withResolvers<string | null>();
        requests.set(file, request);
        return request.promise;
      },
      saveAttachment: async (_task: string, file: string) => { saves.push(file); return { ok: true }; },
    },
  });
  open("T-0029", files, 0, initialSrc);
  const dialog = nodes.find(node => node.tag === "dialog")!;
  const stage = nodes.find(node => node.className === "image-preview-stage")!;
  const status = nodes.find(node => node.className === "image-preview-status")!;
  return {
    reads, saves, requests, decodes, dialog, status, body,
    image: () => stage.children.find(node => node.tag === "img")!,
    title: () => nodes.find(node => node.tag === "strong")!.textContent,
    position: () => nodes.filter(node => node.tag === "output")[1].value,
    click: (text: string) => nodes.find(node => node.tag === "button" && (node.attributes.get("aria-label") ?? node.textContent) === text)!.click!(),
    key: (key: string) => dialog.events.get("keydown")?.({ key, preventDefault() {} }),
    async ready(file: string) {
      requests.get(file)?.resolve("image-" + file);
      await settle();
      decodes.get("image-" + file)!.resolve();
      await settle();
    },
  };
}

test("preview retains the visible image and save target until the next image is decoded", async () => {
  const view = preview();
  await view.ready("0");
  const first = view.image();
  assert.deepEqual(view.reads, ["1", "4"]);
  view.click("Next image");
  assert.equal(view.image(), first);
  assert.equal(first.hidden, false);
  assert.equal(view.title(), "variant-0.png");
  assert.equal(view.position(), "1 / 5");
  await view.click("Save");
  assert.deepEqual(view.saves, ["0"]);
  view.requests.get("1")!.resolve("image-1");
  await settle();
  assert.equal(view.image(), first, "reading the file alone must not replace the image");
  view.decodes.get("image-1")!.resolve();
  await settle();
  assert.equal(view.image().alt, "variant-1.png");
  assert.equal(view.position(), "2 / 5");
  assert.equal(view.status.hidden, true);
  await view.click("Save");
  assert.deepEqual(view.saves, ["0", "1"]);
});

test("cached images switch synchronously without duplicate reads or intermediate loading", async () => {
  const view = preview(2);
  await view.ready("0");
  await view.ready("1");
  assert.deepEqual(view.reads, ["1"], "the same neighbour on both sides is loaded once");
  for (let i = 0; i < 100; i++) {
    view.key("ArrowLeft");
    assert.equal(view.image().alt, "variant-1.png");
    assert.equal(view.position(), "2 / 2");
    assert.equal(view.status.hidden, true);
    view.key("ArrowRight");
    assert.equal(view.image().alt, "variant-0.png");
    assert.equal(view.position(), "1 / 2");
    assert.equal(view.status.hidden, true);
  }
  assert.deepEqual(view.reads, ["1"]);
});

test("out-of-order completions cannot override the latest selection and remain cached", async () => {
  const view = preview();
  await view.ready("0");
  view.key("ArrowRight");
  view.key("ArrowRight");
  await view.ready("2");
  assert.equal(view.image().alt, "variant-2.png");
  await view.ready("1");
  assert.equal(view.image().alt, "variant-2.png");
  view.key("ArrowLeft");
  assert.equal(view.image().alt, "variant-1.png");
  assert.equal(view.status.hidden, true);
});

test("missing, rejected and corrupt images keep the visible image and navigation usable", async () => {
  const view = preview();
  await view.ready("0");
  const first = view.image();
  view.click("Next image");
  view.requests.get("1")!.resolve(null);
  await settle();
  assert.match(view.status.textContent, /unavailable.*variant-1.png/);
  view.click("Next image");
  view.requests.get("2")!.reject(new Error("unreadable"));
  await settle();
  assert.match(view.status.textContent, /unavailable.*variant-2.png/);
  view.click("Next image");
  view.requests.get("3")!.resolve("corrupt");
  await settle();
  view.decodes.get("corrupt")!.reject(new Error("decode failed"));
  await settle();
  assert.match(view.status.textContent, /unavailable.*variant-3.png/);
  assert.equal(view.image(), first);
  assert.equal(first.hidden, false);
  await view.click("Save");
  assert.deepEqual(view.saves, ["0"]);
  view.click("Next image");
  await view.ready("4");
  assert.equal(view.image().alt, "variant-4.png");
  view.click("Next image");
  assert.equal(view.image(), first);
});

test("an unavailable initial image can be skipped and closing invalidates pending decodes", async () => {
  const view = preview(2, null);
  view.requests.get("0")!.resolve(null);
  await settle();
  assert.match(view.status.textContent, /unavailable/);
  view.click("Next image");
  await view.ready("1");
  assert.equal(view.image().alt, "variant-1.png");
  const other = preview(2);
  await other.ready("0");
  other.click("Next image");
  other.requests.get("1")!.resolve("image-1");
  await settle();
  const before = other.image();
  other.dialog.close();
  other.decodes.get("image-1")!.resolve();
  await settle();
  assert.equal(other.image(), before);
  assert.equal(other.body.children.length, 0);
});
