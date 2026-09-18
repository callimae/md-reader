// Wbudowany stan trybu demo (flaga --demo). Nic z tego nie dotyka dysku ani
// prawdziwego store'a — służy do zrzutów i pokazania aplikacji na sucho.

interface DemoNode {
  name: string;
  path: string;
  dir: boolean;
  children?: DemoNode[];
}

const R = "C:\\blog";

export const DEMO_TREE: DemoNode[] = [
  {
    name: "content",
    path: `${R}\\content`,
    dir: true,
    children: [
      {
        name: "posts",
        path: `${R}\\content\\posts`,
        dir: true,
        children: [
          { name: "hello-world.md", path: `${R}\\content\\posts\\hello-world.md`, dir: false },
          { name: "block-editing.md", path: `${R}\\content\\posts\\block-editing.md`, dir: false },
        ],
      },
      {
        name: "notes",
        path: `${R}\\content\\notes`,
        dir: true,
        children: [{ name: "ideas.md", path: `${R}\\content\\notes\\ideas.md`, dir: false }],
      },
      { name: "about.md", path: `${R}\\content\\about.md`, dir: false },
    ],
  },
];

export const DEMO_FILES: Record<string, string> = {
  [`${R}\\content\\posts\\hello-world.md`]: `---
title: "Hello, world"
date: 2026-01-15
draft: false
---

# Hello, world

Welcome to **MD Reader** — a lightweight markdown reader and editor. This document is part of the built-in demo, so feel free to click around.

## Try it

Click any paragraph and it turns into editable *markdown source* right under your cursor. Click away (or press \`Ctrl+Enter\`) and it renders back.

- Bullet lists
- [Links](https://example.com) and \`inline code\`
- Quotes, tables and code blocks

> Click this quote to see its syntax.

\`\`\`js
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

Press \`Ctrl+F\` to search inside the document, or \`Ctrl+Shift+F\` to search the whole repository.
`,
  [`${R}\\content\\posts\\block-editing.md`]: `---
title: "Block editing explained"
date: 2026-02-02
draft: true
---

# Block editing

The document is split into blocks — paragraphs, headings, lists, code fences. Only the block you click becomes editable; the rest stay rendered.

This keeps the page calm to read while letting you edit exactly where you point.
`,
  [`${R}\\content\\notes\\ideas.md`]: `# Ideas

- A word-count goal per post
- Export to PDF
- A distraction-free full-screen mode
`,
  [`${R}\\content\\about.md`]: `---
title: "About"
draft: false
---

# About this blog

A demo blog living in a git repository. Posts are markdown with front matter — publish them straight from MD Reader with **New post** and the **Publish** button.
`,
};

export const DEMO_SETTINGS = {
  lang: "en" as const,
  theme: "dark" as const,
  fontSize: 16,
  blogPath: R,
  workspacePath: R,
  lastSection: "posts",
};

export const DEMO_SECTIONS = ["notes", "posts"];
export const DEMO_OPEN = `${R}\\content\\posts\\hello-world.md`;
