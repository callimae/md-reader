import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { load, Store } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";
import { makeT, type Lang } from "./i18n";
import { DEMO_TREE, DEMO_FILES, DEMO_SETTINGS, DEMO_SECTIONS, DEMO_OPEN } from "./demo";
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

// Obrazki: ścieżki z repo (Hugo static/) i względne wobec pliku → asset protocol.
const defaultImageRule =
  md.renderer.rules.image ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = String(token.attrGet("src") ?? "");
  if (src && !/^(https?:|data:|asset:|blob:)/i.test(src)) {
    let abs: string | null = null;
    if (src.startsWith("/")) {
      const repo = activeRepo();
      if (repo) abs = repo + "\\static" + src.replace(/\//g, "\\");
    } else if (filePath) {
      abs = dirName(filePath) + "\\" + src.replace(/\//g, "\\");
    }
    if (abs) token.attrSet("src", convertFileSrc(abs));
  }
  return defaultImageRule(tokens, idx, options, env, self);
};

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
  workspacePath: string;
}

const DEFAULT_SETTINGS: Settings = {
  lang: "pl",
  theme: "system",
  fontSize: 16,
  blogPath: "",
  lastSection: "wpisy",
  workspacePath: "",
};

interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children?: TreeNode[];
}

// ---------- state ----------

let store: Store;
let recents: RecentEntry[] = [];
let settings: Settings = { ...DEFAULT_SETTINGS };
let t = makeT(settings.lang);
let filePath: string | null = null;
let blocks: string[] = [];
let dirty = false;
let editingIndex: number | null = null;
let tree: TreeNode[] = [];
const expandedDirs = new Set<string>();
let demo = false;
let homeDir = "";

// ---------- document history (undo/redo) ----------

const HISTORY_CAP = 100;
let undoStack: string[] = [];
let redoStack: string[] = [];

function pushHistory() {
  undoStack.push(docText());
  if (undoStack.length > HISTORY_CAP) undoStack.shift();
  redoStack = [];
}

function clearHistory() {
  undoStack = [];
  redoStack = [];
}

function undo() {
  if (editingIndex !== null || !undoStack.length) return;
  redoStack.push(docText());
  blocks = splitBlocks(undoStack.pop()!);
  setDirty(true);
  render();
}

function redo() {
  if (editingIndex !== null || !redoStack.length) return;
  undoStack.push(docText());
  blocks = splitBlocks(redoStack.pop()!);
  setDirty(true);
  render();
}

// W trybie demo wszystkie wywołania backendu dotykające dysku są zastępowane
// odczytem z pamięci; zapis jest bezgłośnie pomijany.
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (demo) {
    switch (cmd) {
      case "read_file":
        return (DEMO_FILES[args?.path as string] ?? "") as T;
      case "write_file":
        return undefined as T;
      case "file_exists":
        return (((args?.path as string) in DEMO_FILES) as unknown) as T;
      case "list_tree":
        return (DEMO_TREE as unknown) as T;
      case "list_dirs":
        return (DEMO_SECTIONS as unknown) as T;
      case "search_files": {
        const q = String(args?.query ?? "").toLowerCase();
        const hits: { path: string; name: string; line: number; snippet: string }[] = [];
        if (q.length >= 2) {
          for (const [path, content] of Object.entries(DEMO_FILES)) {
            content.split("\n").forEach((line, i) => {
              if (line.toLowerCase().includes(q)) {
                hits.push({
                  path,
                  name: path.split("\\").pop() ?? path,
                  line: i + 1,
                  snippet: line.trim().slice(0, 120),
                });
              }
            });
          }
        }
        return (hits as unknown) as T;
      }
      case "git_publish":
        await new Promise((r) => setTimeout(r, 600));
        return ("published" as unknown) as T;
      default:
        return undefined as T;
    }
  }
  return invoke<T>(cmd, args);
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const contentEl = $<HTMLDivElement>("#content");
const recentsEl = $<HTMLDivElement>("#recents");

// ---------- helpers ----------

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dirName = (p: string) => p.slice(0, p.length - fileName(p).length - 1);

// Skraca katalog do czytelnej postaci: profil użytkownika → "~", a długie
// ścieżki do dwóch ostatnich segmentów ("…\Documents\blog").
function prettyDir(dir: string): string {
  const home = homeDir;
  let out = dir;
  if (home && out.toLowerCase().startsWith(home.toLowerCase())) {
    out = "~" + out.slice(home.length);
  }
  const parts = out.split(/[\\/]/).filter(Boolean);
  if (parts.length > 3) return "…\\" + parts.slice(-2).join("\\");
  return out;
}

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

// ---------- toasts & styled confirm ----------

function toast(msg: string, kind: "info" | "success" | "error" = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  window.setTimeout(
    () => {
      el.classList.remove("show");
      window.setTimeout(() => el.remove(), 300);
    },
    kind === "error" ? 6500 : 3500,
  );
}

function confirmModal(title: string, msg: string, okLabel: string): Promise<boolean> {
  const overlay = $("#confirm-overlay");
  $("#c-title").textContent = title;
  $("#c-msg").textContent = msg;
  $("#c-ok").textContent = okLabel;
  $("#c-cancel").textContent = t("cancel");
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      overlay.hidden = true;
      $("#c-ok").removeEventListener("click", ok);
      $("#c-cancel").removeEventListener("click", cancel);
      window.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const ok = () => done(true);
    const cancel = () => done(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancel();
      } else if (e.key === "Enter") {
        e.stopPropagation();
        ok();
      }
    };
    $("#c-ok").addEventListener("click", ok);
    $("#c-cancel").addEventListener("click", cancel);
    window.addEventListener("keydown", onKey, true);
    overlay.hidden = false;
    $<HTMLButtonElement>("#c-cancel").focus();
  });
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
  updateWorkspaceName();
  renderSidebar();
  render();
}

function applyTexts() {
  $("#open-btn").title = t("openTitle");
  $("#settings-btn").title = t("settingsTitle");
  $("#new-post-btn").title = t("newPostTitle");
  $("#publish-btn").title = t("publishTitle");
  $("#open-folder-btn").title = t("openFolderTitle");
  $("#tab-files").textContent = t("tabFiles");
  $("#tab-recent").textContent = t("tabRecent");
  $("#tab-search").textContent = t("tabSearch");
  $<HTMLInputElement>("#wsearch-input").placeholder = t("searchRepoPlaceholder");
  $<HTMLInputElement>("#search-input").placeholder = t("findPlaceholder");
  $("#search-prev").title = t("findPrev");
  $("#search-next").title = t("findNext");
  $("#search-close").title = t("findClose");
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
  if (!demo) await store.set("settings", settings);
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
    const parts = [activeRepo(), "content"];
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

function wordsLabel(n: number): string {
  if (settings.lang === "en") return n === 1 ? "word" : "words";
  if (n === 1) return "słowo";
  const d = n % 10;
  const h = n % 100;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return "słowa";
  return "słów";
}

function updateStatus() {
  const el = $("#statusbar");
  if (filePath === null) {
    el.hidden = true;
    return;
  }
  const { isFrontMatter } = frontMatterInfo();
  const text = blocks
    .slice(isFrontMatter ? 1 : 0)
    .join("\n")
    .replace(/`{3}[\s\S]*?`{3}/g, " ")
    .replace(/[#>*_`[\]()!|-]/g, " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 200));
  el.textContent = `${words} ${wordsLabel(words)} · ${minutes} ${t("minRead")}`;
  el.hidden = false;
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
  pushHistory();
  blocks[0] = blocks[0].replace(/^draft:\s*(true|false)\s*$/m, `draft: ${!draft}`);
  setDirty(true);
  render();
}

async function newPost() {
  const repo = activeRepo();
  if (!repo) {
    toast(t("publishNoBlog"), "error");
    $("#settings-btn").click();
    return;
  }
  if (!(await confirmDiscard())) return;

  let sections: string[] = [];
  try {
    sections = await call<string[]>("list_dirs", { path: `${repo}\\content` });
  } catch (e) {
    toast(`${t("openFail")}\n${repo}\\content\n${e}`, "error");
    return;
  }

  const choice = await newPostModal(sections);
  if (!choice) return;
  if (choice.section && choice.section !== settings.lastSection) {
    settings.lastSection = choice.section;
    saveSettings();
  }

  const slug = slugify(choice.title);
  const dir = choice.section ? `${repo}\\content\\${choice.section}` : `${repo}\\content`;
  const path = `${dir}\\${slug}.md`;
  if (await call<boolean>("file_exists", { path })) {
    toast(`${t("postExists")}\n${path}`, "error");
    return;
  }

  const fm = `---\ntitle: "${choice.title.replace(/"/g, '\\"')}"\ndate: ${localDate()}\ndraft: true\n---`;
  filePath = path;
  blocks = [fm];
  clearHistory();
  try {
    await invoke("write_file", { path, content: docText() });
    setDirty(false);
    await addRecent(path);
    render();
    await loadTree();
    contentEl.parentElement!.scrollTop = 0;
  } catch (e) {
    toast(`${t("saveFail")}\n${e}`, "error");
  }
}

async function publishBlog() {
  const repo = activeRepo();
  if (!repo) {
    toast(t("publishNoBlog"), "error");
    $("#settings-btn").click();
    return;
  }
  if (editingIndex !== null) commitEdit();
  if (dirty && filePath) await saveFile();

  const btn = $("#publish-btn");
  btn.classList.add("busy");
  try {
    const result = await call<string>("git_publish", {
      repo,
      message: `Publikacja z MD Reader (${localDate()})`,
    });
    if (result === "nothing") toast(t("publishNothing"));
    else toast(t("published"), "success");
  } catch (e) {
    toast(`${t("publishFail")}\n${e}`, "error");
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
    $("#statusbar").hidden = true;
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
      const caret = clickToSourceOffset(div, blocks[i], e);
      let target = i;
      if (editingIndex !== null) {
        // Zatwierdzenie edytowanego bloku może go rozbić na kilka —
        // indeks klikniętego bloku przesuwa się o różnicę.
        const wasBefore = editingIndex < i;
        const before = blocks.length;
        commitEdit();
        if (wasBefore) target = i + (blocks.length - before);
      }
      editBlock(target, caret);
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
  updateStatus();
  if (searchOpen) applySearch(true);
}

// Mapuje miejsce kliknięcia w wyrenderowanym bloku na offset w źródle markdown.
// Heurystyka: tekst po renderze to źródło minus znaki składni, więc idziemy po
// prefiksie klikniętego tekstu i doganiamy go w źródle, przeskakując składnię.
function clickToSourceOffset(blockEl: HTMLElement, source: string, e: MouseEvent): number {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const point = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (!point || !blockEl.contains(point.startContainer)) return source.length;

  const range = document.createRange();
  range.selectNodeContents(blockEl);
  range.setEnd(point.startContainer, point.startOffset);
  const prefix = range.toString();

  let si = 0;
  for (const ch of prefix) {
    if (/\s/.test(ch)) {
      while (si < source.length && /\s/.test(source[si])) si++;
      continue;
    }
    const guard = si;
    while (si < source.length && source[si] !== ch) si++;
    if (si >= source.length) {
      // Znak z typografii (np. „ ” –) nie występuje w źródle — pomijamy go.
      si = guard;
      continue;
    }
    si++;
  }
  return si;
}

function wrapSelection(ta: HTMLTextAreaElement, before: string, after: string) {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const sel = ta.value.slice(start, end);
  ta.setRangeText(before + sel + after, start, end, "end");
  ta.setSelectionRange(start + before.length, start + before.length + sel.length);
  autoSize(ta);
}

// Enter na linii listy/cytatu kontynuuje prefiks; Enter na pustym punkcie go usuwa.
function continueListOnEnter(ta: HTMLTextAreaElement): boolean {
  const pos = ta.selectionStart;
  if (pos !== ta.selectionEnd) return false;
  const lineStart = ta.value.lastIndexOf("\n", pos - 1) + 1;
  const line = ta.value.slice(lineStart, pos);
  const m = line.match(/^(\s*)(>\s+|(\d+)([.)])\s+|[-*+]\s+(\[[ xX]\]\s+)?)/);
  if (!m) return false;

  const content = line.slice(m[0].length);
  if (!content.trim()) {
    // Pusty punkt — kończymy listę zamiast mnożyć wykropkowane linie.
    ta.setRangeText("", lineStart, pos, "end");
  } else {
    let prefix = m[0];
    if (m[3]) prefix = m[1] + (Number(m[3]) + 1) + m[4] + " ";
    else if (m[5]) prefix = m[0].replace(/\[[xX]\]/, "[ ]");
    ta.setRangeText("\n" + prefix, pos, pos, "end");
  }
  autoSize(ta);
  return true;
}

function autoSize(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + 2 + "px";
}

function editBlock(index: number, caret?: number) {
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
    } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      if (continueListOnEnter(ta)) e.preventDefault();
    } else if (e.key === "Tab") {
      e.preventDefault();
      ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
    } else if (e.ctrlKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      e.stopPropagation();
      wrapSelection(ta, "**", "**");
    } else if (e.ctrlKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      e.stopPropagation();
      wrapSelection(ta, "*", "*");
    } else if (e.ctrlKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      const start = ta.selectionStart;
      ta.setRangeText(`[${sel}]()`, start, ta.selectionEnd, "end");
      ta.setSelectionRange(start + sel.length + 3, start + sel.length + 3);
      autoSize(ta);
    }
  });
  blockEl.replaceWith(ta);
  autoSize(ta);
  ta.focus();
  const pos = Math.min(caret ?? ta.value.length, ta.value.length);
  ta.setSelectionRange(pos, pos);
}

function commitEdit() {
  const ta = contentEl.querySelector<HTMLTextAreaElement>(".block-editor");
  if (!ta || editingIndex === null) return;
  const index = editingIndex;
  editingIndex = null;

  const newSrc = ta.value;
  if (newSrc !== blocks[index]) {
    pushHistory();
    setDirty(true);
  }

  const replacement = splitBlocks(newSrc);
  blocks.splice(index, 1, ...replacement);
  const scroll = contentEl.parentElement!.scrollTop;
  render();
  contentEl.parentElement!.scrollTop = scroll;
}

// ---------- workspace tree ----------

function activeRepo(): string {
  return settings.workspacePath || settings.blogPath;
}

function updateWorkspaceName() {
  const el = $("#workspace-name");
  const repo = settings.workspacePath;
  el.textContent = repo ? fileName(repo) : t("noWorkspace");
  el.title = repo || t("openFolderTitle");
  el.classList.toggle("empty", !repo);
}

function showTab(tab: "files" | "recent" | "search") {
  $("#tab-files").classList.toggle("active", tab === "files");
  $("#tab-recent").classList.toggle("active", tab === "recent");
  $("#tab-search").classList.toggle("active", tab === "search");
  $("#tree").hidden = tab !== "files";
  $("#recents").hidden = tab !== "recent";
  $("#wsearch").hidden = tab !== "search";
  if (tab === "search") $<HTMLInputElement>("#wsearch-input").focus();
}

async function openFolder() {
  const dir = await open({ directory: true, defaultPath: settings.workspacePath || undefined });
  if (typeof dir !== "string") return;
  settings.workspacePath = dir;
  await saveSettings();
  expandedDirs.clear();
  updateWorkspaceName();
  await loadTree();
  showTab("files");
}

async function loadTree() {
  const root = settings.workspacePath;
  if (!root) {
    tree = [];
    renderTree();
    return;
  }
  try {
    tree = await call<TreeNode[]>("list_tree", { path: root });
  } catch (e) {
    tree = [];
    console.error(e);
  }
  // Domyślnie rozwiń katalog content — tam toczy się praca na blogu.
  for (const node of tree) {
    if (node.dir && node.name === "content") expandedDirs.add(node.path);
  }
  renderTree();
}

function expandAncestorsOf(path: string, nodes: TreeNode[]): boolean {
  for (const node of nodes) {
    if (!node.dir) {
      if (node.path === path) return true;
    } else if (node.children && expandAncestorsOf(path, node.children)) {
      expandedDirs.add(node.path);
      return true;
    }
  }
  return false;
}

function renderTree() {
  const treeEl = $("#tree");
  treeEl.innerHTML = "";

  if (!tree.length) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    const hint = document.createElement("span");
    hint.textContent = t("treeEmpty");
    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = t("openFolderBtn");
    btn.addEventListener("click", openFolder);
    empty.append(hint, btn);
    treeEl.appendChild(empty);
    return;
  }

  if (filePath) expandAncestorsOf(filePath, tree);

  const renderNodes = (nodes: TreeNode[], depth: number, parent: HTMLElement) => {
    for (const node of nodes) {
      const row = document.createElement("div");
      row.className = "tree-row" + (node.dir ? " is-dir" : "");
      row.style.paddingLeft = 8 + depth * 14 + "px";
      row.title = node.path;

      if (node.dir) {
        const chev = document.createElement("span");
        chev.className = "tree-chevron";
        chev.textContent = "▶";
        row.appendChild(chev);
        if (expandedDirs.has(node.path)) row.classList.add("expanded");
      } else {
        const pad = document.createElement("span");
        pad.className = "tree-chevron";
        row.appendChild(pad);
        if (node.path === filePath) row.classList.add("active");
      }

      const name = document.createElement("span");
      name.textContent = node.name;
      row.appendChild(name);

      row.addEventListener("click", () => {
        if (node.dir) {
          if (expandedDirs.has(node.path)) expandedDirs.delete(node.path);
          else expandedDirs.add(node.path);
          renderTree();
        } else {
          openFile(node.path);
        }
      });

      parent.appendChild(row);
      if (node.dir && node.children && expandedDirs.has(node.path)) {
        renderNodes(node.children, depth + 1, parent);
      }
    }
  };
  renderNodes(tree, 0, treeEl);
}

// ---------- in-document search ----------

let searchOpen = false;
let searchHits: HTMLElement[] = [];
let searchIndex = 0;

function clearSearchMarks() {
  for (const m of Array.from(contentEl.querySelectorAll("mark.search-hit"))) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
    parent.normalize();
  }
  searchHits = [];
}

function applySearch(keepIndex = false) {
  const prevIndex = searchIndex;
  clearSearchMarks();
  const q = $<HTMLInputElement>("#search-input").value.toLowerCase();
  if (!q) {
    $("#search-count").textContent = "";
    return;
  }

  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n as Text).parentElement?.closest(".add-block, textarea")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  for (const node of textNodes) {
    let current = node;
    let pos = current.data.toLowerCase().indexOf(q);
    while (pos >= 0) {
      const hit = current.splitText(pos);
      const rest = hit.splitText(q.length);
      const mark = document.createElement("mark");
      mark.className = "search-hit";
      hit.parentNode!.replaceChild(mark, hit);
      mark.appendChild(hit);
      searchHits.push(mark);
      current = rest;
      pos = current.data.toLowerCase().indexOf(q);
    }
  }

  searchIndex = keepIndex ? Math.min(prevIndex, Math.max(searchHits.length - 1, 0)) : 0;
  updateSearchCurrent(false);
}

function updateSearchCurrent(scroll = true) {
  const count = $("#search-count");
  if (!searchHits.length) {
    count.textContent = "0/0";
    return;
  }
  searchHits.forEach((m, i) => m.classList.toggle("current", i === searchIndex));
  count.textContent = `${searchIndex + 1}/${searchHits.length}`;
  if (scroll) searchHits[searchIndex].scrollIntoView({ block: "center" });
}

function searchStep(delta: number) {
  if (!searchHits.length) return;
  searchIndex = (searchIndex + delta + searchHits.length) % searchHits.length;
  updateSearchCurrent();
}

function openSearch() {
  if (filePath === null) return;
  searchOpen = true;
  $("#search-bar").hidden = false;
  $("#main").classList.add("searching");
  const input = $<HTMLInputElement>("#search-input");
  input.focus();
  input.select();
  applySearch();
}

function closeSearch() {
  searchOpen = false;
  $("#search-bar").hidden = true;
  $("#main").classList.remove("searching");
  clearSearchMarks();
}

// Skacze do bloku zawierającego daną linię pliku (linie liczone jak w docText()).
function jumpToLine(line: number) {
  let acc = 0;
  for (let i = 0; i < blocks.length; i++) {
    const len = blocks[i].split("\n").length;
    if (line <= acc + len) {
      const el = contentEl.querySelector(`.block[data-index="${i}"]`);
      el?.scrollIntoView({ block: "center" });
      if (searchHits.length) {
        const inBlock = searchHits.findIndex((m) => el?.contains(m));
        if (inBlock >= 0) {
          searchIndex = inBlock;
          updateSearchCurrent();
        }
      }
      return;
    }
    acc += len + 1; // +1 za pustą linię między blokami
  }
}

// ---------- workspace search ----------

interface SearchHit {
  path: string;
  name: string;
  line: number;
  snippet: string;
}

let wsearchTimer: number | undefined;

async function runWorkspaceSearch() {
  const resultsEl = $("#wsearch-results");
  const query = $<HTMLInputElement>("#wsearch-input").value.trim();
  const root = activeRepo();
  if (query.length < 2) {
    resultsEl.innerHTML = `<div class="wsearch-empty">${t("searchTooShort")}</div>`;
    return;
  }
  if (!root) {
    resultsEl.innerHTML = `<div class="wsearch-empty">${t("treeEmpty")}</div>`;
    return;
  }
  let hits: SearchHit[] = [];
  try {
    hits = await call<SearchHit[]>("search_files", { root, query });
  } catch (e) {
    console.error(e);
  }
  resultsEl.innerHTML = "";
  if (!hits.length) {
    resultsEl.innerHTML = `<div class="wsearch-empty">${t("searchNoResults")}</div>`;
    return;
  }

  let lastPath = "";
  for (const hit of hits) {
    if (hit.path !== lastPath) {
      lastPath = hit.path;
      const file = document.createElement("div");
      file.className = "wsearch-file";
      file.textContent = hit.name;
      file.title = hit.path;
      resultsEl.appendChild(file);
    }
    const row = document.createElement("div");
    row.className = "wsearch-hit";
    const lineNo = document.createElement("span");
    lineNo.className = "line-no";
    lineNo.textContent = String(hit.line);
    row.append(lineNo, document.createTextNode(hit.snippet));
    row.title = hit.snippet;
    row.addEventListener("click", async () => {
      await openFile(hit.path);
      $<HTMLInputElement>("#search-input").value = query;
      openSearch();
      jumpToLine(hit.line);
    });
    resultsEl.appendChild(row);
  }
}

// ---------- recent files sidebar ----------

async function addRecent(path: string) {
  recents = [{ path, openedAt: Date.now() }, ...recents.filter((r) => r.path !== path)].slice(0, 50);
  if (!demo) await store.set("recents", recents);
  renderSidebar();
}

async function removeRecent(path: string) {
  recents = recents.filter((r) => r.path !== path);
  if (!demo) await store.set("recents", recents);
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
    label.textContent = prettyDir(dir);
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
  return confirmModal(t("unsavedTitle"), t("unsavedMsg"), t("discard"));
}

async function openFile(path: string) {
  if (path === filePath) return;
  if (!(await confirmDiscard())) return;
  try {
    const text = await call<string>("read_file", { path });
    filePath = path;
    blocks = splitBlocks(text);
    clearHistory();
    setDirty(false);
    await addRecent(path);
    render();
    renderTree();
    contentEl.parentElement!.scrollTop = 0;
  } catch (e) {
    await removeRecent(path);
    toast(`${t("openFail")}\n${e}`, "error");
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
    toast(`${t("saveFail")}\n${e}`, "error");
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
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    showTab("search");
  } else if (e.ctrlKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openSearch();
  } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z" && editingIndex === null) {
    e.preventDefault();
    undo();
  } else if (
    (e.ctrlKey && e.key.toLowerCase() === "y") ||
    (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z")
  ) {
    if (editingIndex === null) {
      e.preventDefault();
      redo();
    }
  } else if (e.key === "Escape" && searchOpen) {
    closeSearch();
  }
});

$("#open-btn").addEventListener("click", openDialog);
$("#open-folder-btn").addEventListener("click", openFolder);
$("#workspace-name").addEventListener("click", openFolder);
$("#new-post-btn").addEventListener("click", newPost);
$("#publish-btn").addEventListener("click", publishBlog);
$("#draft-pill").addEventListener("click", toggleDraft);
$("#tab-files").addEventListener("click", () => showTab("files"));
$("#tab-recent").addEventListener("click", () => showTab("recent"));
$("#tab-search").addEventListener("click", () => showTab("search"));

$<HTMLInputElement>("#wsearch-input").addEventListener("input", () => {
  window.clearTimeout(wsearchTimer);
  wsearchTimer = window.setTimeout(runWorkspaceSearch, 300);
});

$<HTMLInputElement>("#search-input").addEventListener("input", () => applySearch());
$<HTMLInputElement>("#search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchStep(e.shiftKey ? -1 : 1);
  else if (e.key === "Escape") closeSearch();
  e.stopPropagation();
});
$("#search-prev").addEventListener("click", () => searchStep(-1));
$("#search-next").addEventListener("click", () => searchStep(1));
$("#search-close").addEventListener("click", closeSearch);

(async () => {
  demo = await invoke<boolean>("is_demo").catch(() => false);
  homeDir = demo ? "C:\\Users\\writer" : await invoke<string>("home_dir").catch(() => "");

  if (demo) {
    settings = { ...DEFAULT_SETTINGS, ...DEMO_SETTINGS };
  } else {
    store = await load("recents.json", { autoSave: true });
    recents = (await store.get<RecentEntry[]>("recents")) ?? [];
    settings = { ...DEFAULT_SETTINGS, ...((await store.get<Partial<Settings>>("settings")) ?? {}) };
    if (!settings.workspacePath && settings.blogPath) {
      settings.workspacePath = settings.blogPath;
    }
  }
  initSettingsPanel();
  applySettings();
  updateTitle();
  await loadTree();
  showTab(tree.length ? "files" : "recent");

  if (demo) {
    await openFile(DEMO_OPEN);
  } else {
    try {
      const startFile = await invoke<string | null>("startup_file");
      if (startFile) await openFile(startFile);
    } catch (e) {
      console.error(e);
    }
  }

  const win = getCurrentWindow();

  await win.onCloseRequested(async (event) => {
    if (editingIndex !== null) commitEdit();
    if (!(await confirmDiscard())) event.preventDefault();
  });

  await win.onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      const path = event.payload.paths.find((p) => /\.(md|markdown|txt)$/i.test(p));
      if (path) openFile(path);
    }
  });
})();
