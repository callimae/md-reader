import { invoke } from "@tauri-apps/api/core";
import { open, save, confirm, message } from "@tauri-apps/plugin-dialog";
import { load, Store } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";
import { makeT, type Lang } from "./i18n";
import "./styles.css";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        return `<pre><code class="hljs language-${lang}">${html}</code></pre>`;
      } catch {
        /* fall through to default escaping */
      }
    }
    return "";
  },
});

interface RecentEntry {
  path: string;
  openedAt: number;
}

interface Settings {
  lang: Lang;
  theme: "system" | "light" | "dark";
  fontSize: number;
  blogPath: string;
  lastSection: string;
}

const DEFAULT_SETTINGS: Settings = {
  lang: "pl",
  theme: "system",
  fontSize: 16,
  blogPath: "",
  lastSection: "wpisy",
};

// ---------- state ----------

let store: Store;
let recents: RecentEntry[] = [];
let settings: Settings = { ...DEFAULT_SETTINGS };
let t = makeT(settings.lang);
let filePath: string | null = null;
let blocks: string[] = [];
let dirty = false;
let editingIndex: number | null = null;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const contentEl = $<HTMLDivElement>("#content");
const recentsEl = $<HTMLDivElement>("#recents");

// ---------- helpers ----------

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dirName = (p: string) => p.slice(0, p.length - fileName(p).length - 1);

function docText(): string {
  return blocks.join("\n\n") + (blocks.length ? "\n" : "");
}

function updateTitle() {
  const name = filePath ? fileName(filePath) : "MD Reader";
  document.title = (dirty ? "● " : "") + name + (filePath ? " — MD Reader" : "");
}

function setDirty(v: boolean) {
  dirty = v;
  updateTitle();
}

// Splits markdown into top-level blocks on blank lines, keeping fenced code intact.
function splitBlocks(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
    }
    if (fence === null && line.trim() === "") {
      if (cur.length) {
        out.push(cur.join("\n"));
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

// ---------- settings ----------

function applySettings() {
  t = makeT(settings.lang);
  document.documentElement.lang = settings.lang;
  if (settings.theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = settings.theme;
  }
  document.documentElement.style.setProperty("--doc-font-size", settings.fontSize + "px");
  applyTexts();
  renderSidebar();
  render();
}

function applyTexts() {
  $("#open-btn").title = t("openTitle");
  $("#settings-btn").title = t("settingsTitle");
  $("#new-post-btn").title = t("newPostTitle");
  $("#publish-btn").title = t("publishTitle");
  $("#s-blog-label").textContent = t("blogFolder");
  $("#s-blog-browse").textContent = t("browse");
  $("#p-title").textContent = t("postTitlePrompt");
  $("#p-section-label").textContent = t("sectionLabel");
  $("#p-ok").textContent = t("create");
  $("#p-cancel").textContent = t("cancel");
  $("#s-title").textContent = t("settingsTitle");
  $("#s-lang-label").textContent = t("language");
  $("#s-theme-label").textContent = t("theme");
  $("#s-font-label").textContent = t("fontSize");
  $("#s-close").textContent = t("close");
  const themeSelect = $<HTMLSelectElement>("#s-theme");
  const labels = { system: t("themeSystem"), light: t("themeLight"), dark: t("themeDark") };
  for (const opt of Array.from(themeSelect.options)) {
    opt.textContent = labels[opt.value as keyof typeof labels];
  }
}

async function saveSettings() {
  await store.set("settings", settings);
  applySettings();
}

function initSettingsPanel() {
  const overlay = $("#settings-overlay");
  const langSel = $<HTMLSelectElement>("#s-lang");
  const themeSel = $<HTMLSelectElement>("#s-theme");
  const fontRange = $<HTMLInputElement>("#s-font");
  const fontVal = $("#s-font-val");

  const blogInput = $<HTMLInputElement>("#s-blog");

  $("#settings-btn").addEventListener("click", () => {
    langSel.value = settings.lang;
    themeSel.value = settings.theme;
    fontRange.value = String(settings.fontSize);
    fontVal.textContent = settings.fontSize + "px";
    blogInput.value = settings.blogPath;
    overlay.hidden = false;
  });

  blogInput.addEventListener("change", () => {
    settings.blogPath = blogInput.value.trim();
    saveSettings();
  });
  $("#s-blog-browse").addEventListener("click", async () => {
    const dir = await open({ directory: true, defaultPath: settings.blogPath || undefined });
    if (typeof dir === "string") {
      blogInput.value = dir;
      settings.blogPath = dir;
      saveSettings();
    }
  });

  langSel.addEventListener("change", () => {
    settings.lang = langSel.value as Lang;
    saveSettings();
  });
  themeSel.addEventListener("change", () => {
    settings.theme = themeSel.value as Settings["theme"];
    saveSettings();
  });
  fontRange.addEventListener("input", () => {
    settings.fontSize = Number(fontRange.value);
    fontVal.textContent = settings.fontSize + "px";
    saveSettings();
  });

  const close = () => (overlay.hidden = true);
  $("#s-close").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) close();
  });
}

// ---------- prompt modal ----------

interface NewPostChoice {
  title: string;
  section: string;
}

function newPostModal(sections: string[]): Promise<NewPostChoice | null> {
  const overlay = $("#prompt-overlay");
  const input = $<HTMLInputElement>("#p-input");
  const sectionRow = $("#p-section").parentElement as HTMLElement;
  const sectionSel = $<HTMLSelectElement>("#p-section");
  const pathPreview = $("#p-path");

  sectionSel.innerHTML = "";
  for (const s of sections) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    sectionSel.appendChild(opt);
  }
  sectionRow.hidden = sections.length === 0;
  if (sections.includes(settings.lastSection)) sectionSel.value = settings.lastSection;

  const updatePreview = () => {
    const parts = [settings.blogPath, "content"];
    if (sections.length) parts.push(sectionSel.value);
    parts.push(slugify(input.value) + ".md");
    pathPreview.textContent = parts.join("\\");
  };

  return new Promise((resolve) => {
    const done = (value: NewPostChoice | null) => {
      overlay.hidden = true;
      $("#p-ok").removeEventListener("click", ok);
      $("#p-cancel").removeEventListener("click", cancel);
      input.removeEventListener("keydown", onKey);
      input.removeEventListener("input", updatePreview);
      sectionSel.removeEventListener("change", updatePreview);
      resolve(value);
    };
    const ok = () => {
      const title = input.value.trim();
      done(title ? { title, section: sections.length ? sectionSel.value : "" } : null);
    };
    const cancel = () => done(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") ok();
      else if (e.key === "Escape") cancel();
      e.stopPropagation();
    };
    $("#p-ok").addEventListener("click", ok);
    $("#p-cancel").addEventListener("click", cancel);
    input.addEventListener("keydown", onKey);
    input.addEventListener("input", updatePreview);
    sectionSel.addEventListener("change", updatePreview);
    input.value = "";
    updatePreview();
    overlay.hidden = false;
    input.focus();
  });
}

// ---------- blog (Hugo) ----------

const PL_CHARS: Record<string, string> = {
  ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z",
};

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => PL_CHARS[c])
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "wpis";
}

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function frontMatterInfo(): { isFrontMatter: boolean; draft: boolean | null } {
  const b = blocks[0];
  if (!b || !/^---\n[\s\S]*\n---$/.test(b)) return { isFrontMatter: false, draft: null };
  const m = b.match(/^draft:\s*(true|false)\s*$/m);
  return { isFrontMatter: true, draft: m ? m[1] === "true" : null };
}

function updateDraftPill() {
  const pill = $<HTMLButtonElement>("#draft-pill");
  const { draft } = frontMatterInfo();
  if (draft === null) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  pill.className = draft ? "is-draft" : "is-public";
  pill.textContent = draft ? t("draftBadge") : t("publicBadge");
  pill.title = draft ? t("draftTooltip") : t("publicTooltip");
}

function toggleDraft() {
  const { draft } = frontMatterInfo();
  if (draft === null) return;
  blocks[0] = blocks[0].replace(/^draft:\s*(true|false)\s*$/m, `draft: ${!draft}`);
  setDirty(true);
  render();
}

async function newPost() {
  if (!settings.blogPath) {
    alert(t("publishNoBlog"));
    $("#settings-btn").click();
    return;
  }
  if (!(await confirmDiscard())) return;

  let sections: string[] = [];
  try {
    sections = await invoke<string[]>("list_dirs", { path: `${settings.blogPath}\\content` });
  } catch (e) {
    alert(`${t("openFail")}\n${settings.blogPath}\\content\n${e}`);
    return;
  }

  const choice = await newPostModal(sections);
  if (!choice) return;
  if (choice.section && choice.section !== settings.lastSection) {
    settings.lastSection = choice.section;
    saveSettings();
  }

  const slug = slugify(choice.title);
  const dir = choice.section
    ? `${settings.blogPath}\\content\\${choice.section}`
    : `${settings.blogPath}\\content`;
  const path = `${dir}\\${slug}.md`;
  if (await invoke<boolean>("file_exists", { path })) {
    alert(`${t("postExists")}\n${path}`);
    return;
  }

  const fm = `---\ntitle: "${choice.title.replace(/"/g, '\\"')}"\ndate: ${localDate()}\ndraft: true\n---`;
  filePath = path;
  blocks = [fm];
  try {
    await invoke("write_file", { path, content: docText() });
    setDirty(false);
    await addRecent(path);
    render();
    contentEl.parentElement!.scrollTop = 0;
  } catch (e) {
    alert(`${t("saveFail")}\n${e}`);
  }
}

async function publishBlog() {
  if (!settings.blogPath) {
    alert(t("publishNoBlog"));
    $("#settings-btn").click();
    return;
  }
  if (editingIndex !== null) commitEdit();
  if (dirty && filePath) await saveFile();

  const btn = $("#publish-btn");
  btn.classList.add("busy");
  try {
    const result = await invoke<string>("git_publish", {
      repo: settings.blogPath,
      message: `Publikacja z MD Reader (${localDate()})`,
    });
    await message(result === "nothing" ? t("publishNothing") : t("published"), {
      title: "MD Reader",
    });
  } catch (e) {
    await message(`${t("publishFail")}\n${e}`, { title: "MD Reader", kind: "error" });
  } finally {
    btn.classList.remove("busy");
  }
}

// ---------- rendering ----------

function render() {
  editingIndex = null;
  contentEl.innerHTML = "";

  if (filePath === null) {
    contentEl.innerHTML = `
      <div id="welcome">
        <h1>MD Reader</h1>
        <p>${t("welcomeLine1")}</p>
        <p>${t("welcomeLine2")}</p>
      </div>`;
    $("#draft-pill").hidden = true;
    return;
  }

  const { isFrontMatter } = frontMatterInfo();

  blocks.forEach((src, i) => {
    const div = document.createElement("div");
    div.className = "block";
    div.dataset.index = String(i);
    if (i === 0 && isFrontMatter) {
      div.classList.add("front-matter");
      for (const line of src.split("\n").slice(1, -1)) {
        const row = document.createElement("div");
        row.className = "fm-row";
        const sep = line.indexOf(":");
        const key = document.createElement("span");
        key.className = "fm-key";
        key.textContent = sep > 0 ? line.slice(0, sep) : "";
        const val = document.createElement("span");
        val.textContent = sep > 0 ? line.slice(sep + 1).trim() : line;
        row.append(key, val);
        div.appendChild(row);
      }
    } else {
      div.innerHTML = md.render(src);
    }
    div.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("a")) return;
      e.preventDefault();
      editBlock(i);
    });
    contentEl.appendChild(div);
  });

  const tail = document.createElement("div");
  tail.className = "add-block";
  tail.title = t("addBlock");
  tail.addEventListener("mousedown", (e) => {
    e.preventDefault();
    blocks.push("");
    render();
    editBlock(blocks.length - 1);
  });
  contentEl.appendChild(tail);
  updateDraftPill();
}

function autoSize(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + 2 + "px";
}

function editBlock(index: number) {
  if (editingIndex !== null) commitEdit();
  const blockEl = contentEl.querySelector<HTMLDivElement>(`.block[data-index="${index}"]`);
  if (!blockEl) return;

  editingIndex = index;
  const ta = document.createElement("textarea");
  ta.className = "block-editor";
  ta.value = blocks[index];
  ta.addEventListener("input", () => autoSize(ta));
  ta.addEventListener("blur", () => commitEdit());
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      ta.value = blocks[index];
      commitEdit();
    } else if (e.key === "Enter" && e.ctrlKey) {
      commitEdit();
    } else if (e.key === "Tab") {
      e.preventDefault();
      ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
    }
  });
  blockEl.replaceWith(ta);
  autoSize(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function commitEdit() {
  const ta = contentEl.querySelector<HTMLTextAreaElement>(".block-editor");
  if (!ta || editingIndex === null) return;
  const index = editingIndex;
  editingIndex = null;

  const newSrc = ta.value;
  if (newSrc !== blocks[index]) setDirty(true);

  const replacement = splitBlocks(newSrc);
  blocks.splice(index, 1, ...replacement);
  const scroll = contentEl.parentElement!.scrollTop;
  render();
  contentEl.parentElement!.scrollTop = scroll;
}

// ---------- recent files sidebar ----------

async function addRecent(path: string) {
  recents = [{ path, openedAt: Date.now() }, ...recents.filter((r) => r.path !== path)].slice(0, 50);
  await store.set("recents", recents);
  renderSidebar();
}

async function removeRecent(path: string) {
  recents = recents.filter((r) => r.path !== path);
  await store.set("recents", recents);
  renderSidebar();
}

function renderSidebar() {
  recentsEl.innerHTML = "";
  if (!recents.length) {
    recentsEl.innerHTML = `<div class="recents-empty">${t("recentsEmpty")}</div>`;
    return;
  }

  const groups = new Map<string, RecentEntry[]>();
  for (const r of recents) {
    const dir = dirName(r.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(r);
  }

  for (const [dir, entries] of groups) {
    const group = document.createElement("div");
    group.className = "folder-group";
    const label = document.createElement("div");
    label.className = "folder-name";
    label.textContent = dir;
    label.title = dir;
    group.appendChild(label);

    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = "recent-item" + (entry.path === filePath ? " active" : "");
      item.title = entry.path;

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = fileName(entry.path);
      item.appendChild(name);

      const remove = document.createElement("button");
      remove.className = "remove";
      remove.textContent = "✕";
      remove.title = t("removeFromList");
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        removeRecent(entry.path);
      });
      item.appendChild(remove);

      item.addEventListener("click", () => openFile(entry.path));
      group.appendChild(item);
    }
    recentsEl.appendChild(group);
  }
}

// ---------- file operations ----------

async function confirmDiscard(): Promise<boolean> {
  if (!dirty) return true;
  return confirm(t("unsavedMsg"), { title: t("unsavedTitle"), kind: "warning" });
}

async function openFile(path: string) {
  if (path === filePath) return;
  if (!(await confirmDiscard())) return;
  try {
    const text = await invoke<string>("read_file", { path });
    filePath = path;
    blocks = splitBlocks(text);
    setDirty(false);
    await addRecent(path);
    render();
    contentEl.parentElement!.scrollTop = 0;
  } catch (e) {
    await removeRecent(path);
    alert(`${t("openFail")}\n${e}`);
  }
}

async function openDialog() {
  const selected = await open({
    multiple: false,
    filters: [{ name: t("markdownFiles"), extensions: ["md", "markdown", "txt"] }],
  });
  if (typeof selected === "string") await openFile(selected);
}

async function saveFile() {
  if (editingIndex !== null) commitEdit();
  if (filePath === null && blocks.length === 0) return;
  let target = filePath;
  if (!target) {
    target = await save({ filters: [{ name: t("markdownFiles"), extensions: ["md"] }] });
    if (!target) return;
    filePath = target;
    await addRecent(target);
  }
  try {
    await invoke("write_file", { path: target, content: docText() });
    setDirty(false);
    renderSidebar();
  } catch (e) {
    alert(`${t("saveFail")}\n${e}`);
  }
}

// ---------- init ----------

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveFile();
  } else if (e.ctrlKey && e.key.toLowerCase() === "o") {
    e.preventDefault();
    openDialog();
  } else if (e.ctrlKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newPost();
  }
});

$("#open-btn").addEventListener("click", openDialog);
$("#new-post-btn").addEventListener("click", newPost);
$("#publish-btn").addEventListener("click", publishBlog);
$("#draft-pill").addEventListener("click", toggleDraft);

(async () => {
  store = await load("recents.json", { autoSave: true });
  recents = (await store.get<RecentEntry[]>("recents")) ?? [];
  settings = { ...DEFAULT_SETTINGS, ...((await store.get<Partial<Settings>>("settings")) ?? {}) };
  initSettingsPanel();
  applySettings();
  updateTitle();

  const win = getCurrentWindow();

  await win.onCloseRequested(async (event) => {
    if (editingIndex !== null) commitEdit();
    if (dirty && !(await confirm(t("unsavedMsg"), { title: t("unsavedTitle"), kind: "warning" }))) {
      event.preventDefault();
    }
  });

  await win.onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      const path = event.payload.paths.find((p) => /\.(md|markdown|txt)$/i.test(p));
      if (path) openFile(path);
    }
  });
})();
