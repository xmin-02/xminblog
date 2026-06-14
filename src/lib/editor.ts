/**
 * Block-style rich editor for blog posts.
 * New post bodies are stored as HTML; legacy Markdown is accepted and converted.
 *
 * Features
 *   - Tiptap-based block editor (Notion-like UX)
 *   - Slash commands ("/제목", "/표", etc.)
 *   - Image paste / drop → POST /api/upload → insert as image
 *   - Tables, lists, code blocks, blockquote, hr, link
 */

import { Editor, Extension, Mark, mergeAttributes } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Image } from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import Suggestion from '@tiptap/suggestion';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { marked } from 'marked';
import TurndownService from 'turndown';
// @ts-expect-error — no types
import { gfm } from 'turndown-plugin-gfm';

export interface BlogEditorOptions {
  element: HTMLElement;
  initialMarkdown?: string;
  apiBase: string;
  getAuthToken: () => string | null;
  onChange?: (markdown: string) => void;
}

export interface BlogEditorHandle {
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  destroy: () => void;
  editor: Editor;
}

// ── Markdown ↔ HTML ─────────────────────────────────────────────────────────

marked.setOptions({ gfm: true, breaks: false });

const codeLanguageLabels: Record<string, string> = {
  c: 'C',
  cpp: 'C++',
  cxx: 'C++',
  cc: 'C++',
  h: 'C',
  hpp: 'C++',
  asm: 'ASM',
  nasm: 'ASM',
  windbg: 'WinDbg',
  dbg: 'WinDbg',
  text: 'TEXT',
  txt: 'TEXT',
  sh: 'Shell',
  shell: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  powershell: 'PowerShell',
  ps1: 'PowerShell',
  js: 'JavaScript',
  javascript: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  python: 'Python',
  py: 'Python',
  rust: 'Rust',
  rs: 'Rust',
  go: 'Go',
  sql: 'SQL',
};

function normalizeCodeLanguage(raw?: string | null): string {
  const first = String(raw || '').trim().split(/\s+/)[0] || '';
  const clean = first.toLowerCase().replace(/^\./, '').replace(/[^a-z0-9+#_-]/g, '');
  if (clean === 'c++') return 'cpp';
  if (clean === 'objective-c' || clean === 'objc') return 'objc';
  return clean || 'text';
}

function codeLanguageLabel(raw?: string | null): string {
  const normalized = normalizeCodeLanguage(raw);
  return codeLanguageLabels[normalized] || normalized.toUpperCase();
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});
turndown.use(gfm);
// Preserve image alt + url, and encode an explicit width as a `"w=NNN"` title
// so resize survives the Markdown round-trip (rehype-figure reads it on render).
turndown.addRule('img', {
  filter: 'img',
  replacement: (_content, node) => {
    const el = node as HTMLImageElement;
    const alt = (el.getAttribute('alt') ?? '').replace(/[\[\]]/g, '');
    const src = el.getAttribute('src') ?? '';
    if (!src) return '';
    const rawW = el.getAttribute('width') || (el.style && el.style.width) || '';
    const w = parseInt(String(rawW), 10);
    const title = Number.isFinite(w) && w > 0 ? ` "w=${w}"` : '';
    return `![${alt}](${src}${title})`;
  },
});

export function mdToHtml(md: string): string {
  return marked.parse(md ?? '', { async: false }) as string;
}
export function htmlToMd(html: string): string {
  return turndown.turndown(html ?? '');
}

/** Body content may be HTML (new editor format) or legacy Markdown. */
export function isHtmlContent(s: string): boolean {
  return /^\s*<(p|h[1-6]|ul|ol|blockquote|pre|table|figure|div|hr|img|span)[\s>]/i.test(s ?? '');
}
/** Normalize either format into HTML for the editor. */
function contentToHtml(s: string): string {
  return isHtmlContent(s) ? s : mdToHtml(s);
}

function looksLikeMarkdownPaste(text: string): boolean {
  const value = String(text || '');
  if (value.length < 3) return false;
  return /(^|\n)```[^\n]*\n/.test(value)
    || /(^|\n)#{1,4}\s+\S/.test(value)
    || /(^|\n)>\s+\S/.test(value)
    || /(^|\n)\s*[-*]\s+\S/.test(value)
    || /(^|\n)\s*\d+\.\s+\S/.test(value)
    || /(^|\n)\|.+\|\n\s*\|?[\s|:-]+\|/.test(value)
    || /!\[[^\]]*]\([^)]+\)/.test(value)
    || /\[[^\]]+]\([^)]+\)/.test(value);
}

const LanguageCodeBlock = CodeBlock.extend({
  renderHTML({ node, HTMLAttributes }) {
    const language = normalizeCodeLanguage(node.attrs.language);
    const hasLanguage = language && language !== 'text';
    return [
      'pre',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-code-lang': hasLanguage ? codeLanguageLabel(language) : null,
      }),
      [
        'code',
        {
          class: hasLanguage ? `${this.options.languageClassPrefix}${language}` : null,
        },
        0,
      ],
    ];
  },
});

// ── Resizable image ─────────────────────────────────────────────────────────
// Extends the base Image node with a `width` attribute and a drag-handle
// NodeView. Width is parsed from a `width` attr or a `"w=NNN"` markdown title,
// and rendered back as a `width` attr (turndown re-encodes it into the title).
const ResizableImage = Image.extend({
  addAttributes() {
    return {
      // @ts-expect-error — parent attrs exist at runtime
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const wAttr = el.getAttribute('width');
          if (wAttr && parseInt(wAttr, 10)) return parseInt(wAttr, 10);
          const m = (el.getAttribute('title') || '').match(/w=(\d+)/);
          return m ? parseInt(m[1], 10) : null;
        },
        renderHTML: (attrs: { width?: number | null }) =>
          attrs.width ? { width: attrs.width } : {},
      },
    };
  },
  addNodeView() {
    return ({ node, editor, getPos }: any) => {
      const dom = document.createElement('div');
      dom.className = 'tt-img-wrap';
      const img = document.createElement('img');
      img.src = node.attrs.src;
      img.alt = node.attrs.alt || '';
      img.className = 'tt-img';
      if (node.attrs.width) img.style.width = node.attrs.width + 'px';
      dom.appendChild(img);

      const handle = document.createElement('span');
      handle.className = 'tt-img-handle';
      handle.title = '드래그해서 크기 조절';
      dom.appendChild(handle);

      let startX = 0;
      let startW = 0;
      const onMove = (e: MouseEvent) => {
        const max = (dom.parentElement?.clientWidth || 900);
        const w = Math.max(80, Math.min(Math.round(startW + (e.clientX - startX)), max));
        img.style.width = w + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const finalW = Math.round(img.getBoundingClientRect().width);
        if (typeof getPos === 'function') {
          editor.chain().focus().command(({ tr }: any) => {
            tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, width: finalW });
            return true;
          }).run();
        }
      };
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX;
        startW = img.getBoundingClientRect().width;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      return {
        dom,
        update: (updated: any) => {
          if (updated.type.name !== node.type.name) return false;
          if (updated.attrs.src !== img.getAttribute('src')) img.src = updated.attrs.src;
          img.alt = updated.attrs.alt || '';
          img.style.width = updated.attrs.width ? updated.attrs.width + 'px' : '';
          return true;
        },
      };
    };
  },
});

// ── Slash command items ─────────────────────────────────────────────────────

interface SlashItem {
  title: string;
  hint: string;
  keywords: string[];
  command: (ctx: { editor: Editor; range: { from: number; to: number } }) => void;
}

function buildSlashItems(uploadImage: () => void): SlashItem[] {
  return [
    {
      title: '제목 1', hint: '#', keywords: ['heading', 'h1', '제목', 'title'],
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
    },
    {
      title: '제목 2', hint: '##', keywords: ['heading', 'h2', '제목'],
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
    },
    {
      title: '제목 3', hint: '###', keywords: ['heading', 'h3', '제목'],
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
    },
    {
      title: '본문', hint: '', keywords: ['paragraph', 'text', '본문', '단락'],
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('paragraph').run(),
    },
    {
      title: '글머리 목록', hint: '-', keywords: ['list', 'bullet', '목록'],
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      title: '번호 목록', hint: '1.', keywords: ['list', 'ordered', '번호'],
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
    {
      title: '인용', hint: '>', keywords: ['quote', 'blockquote', '인용'],
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
      title: '코드 블록', hint: '```', keywords: ['code', 'block', '코드'],
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      title: '표', hint: 'table', keywords: ['table', '표', 'grid'],
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      title: '구분선', hint: '---', keywords: ['hr', 'divider', '구분선'],
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },
    {
      title: '이미지 (URL)', hint: 'image', keywords: ['image', 'img', '이미지', 'url'],
      command: ({ editor, range }) => {
        const url = window.prompt('이미지 URL');
        if (!url) return;
        editor.chain().focus().deleteRange(range).setImage({ src: url }).run();
      },
    },
    {
      title: '이미지 (업로드)', hint: 'upload', keywords: ['upload', '업로드', 'image', '이미지'],
      command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).run(); uploadImage(); },
    },
  ];
}

// ── Slash menu UI (vanilla DOM) ─────────────────────────────────────────────

function renderSlashMenu(initialProps: any) {
  const dom = document.createElement('div');
  dom.className = 'slash-menu';
  let props = initialProps;
  let selected = 0;

  const draw = () => {
    const items: SlashItem[] = props.items ?? [];
    dom.innerHTML = '';
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'slash-empty';
      e.textContent = '결과 없음';
      dom.appendChild(e);
      return;
    }
    items.forEach((item, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slash-item' + (i === selected ? ' is-selected' : '');
      btn.innerHTML = `<span class="slash-title">${escapeHtml(item.title)}</span><span class="slash-sub">${escapeHtml(item.hint)}</span>`;
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        props.command(item);
      });
      btn.addEventListener('mouseenter', () => { selected = i; draw(); });
      dom.appendChild(btn);
    });
  };
  draw();

  return {
    dom,
    update(newProps: any) { props = newProps; selected = 0; draw(); },
    onKeyDown({ event }: any) {
      const items: SlashItem[] = props.items ?? [];
      if (!items.length) return false;
      if (event.key === 'ArrowDown') { selected = (selected + 1) % items.length; draw(); return true; }
      if (event.key === 'ArrowUp')   { selected = (selected - 1 + items.length) % items.length; draw(); return true; }
      if (event.key === 'Enter')     { props.command(items[selected]); return true; }
      return false;
    },
    destroy() { dom.remove(); },
  };
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Slash command extension ────────────────────────────────────────────────

function createSlashExtension(uploadImage: () => void) {
  return Extension.create({
    name: 'slashCommand',
    addOptions() {
      return {
        suggestion: {
          char: '/',
          startOfLine: false,
          allowSpaces: false,
          command: ({ editor, range, props }: any) => props.command({ editor, range }),
        },
      };
    },
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          ...this.options.suggestion,
          items: ({ query }: { query: string }) => {
            const all = buildSlashItems(uploadImage);
            const q = query.toLowerCase();
            if (!q) return all.slice(0, 10);
            return all
              .filter(i => i.title.toLowerCase().includes(q) || i.keywords.some(k => k.toLowerCase().includes(q)))
              .slice(0, 10);
          },
          render: () => {
            let component: ReturnType<typeof renderSlashMenu>;
            let popup: TippyInstance[] = [];
            return {
              onStart: (props: any) => {
                component = renderSlashMenu(props);
                popup = tippy('body', {
                  getReferenceClientRect: props.clientRect,
                  appendTo: () => document.body,
                  content: component.dom,
                  showOnCreate: true,
                  interactive: true,
                  trigger: 'manual',
                  placement: 'bottom-start',
                  arrow: false,
                });
              },
              onUpdate: (props: any) => {
                component.update(props);
                if (popup[0]) popup[0].setProps({ getReferenceClientRect: props.clientRect });
              },
              onKeyDown: (props: any) => {
                if (props.event.key === 'Escape') { popup[0]?.hide(); return true; }
                return component.onKeyDown(props);
              },
              onExit: () => {
                popup[0]?.destroy();
                component.destroy();
              },
            };
          },
        }),
      ];
    },
  });
}

// ── Table toolbar ───────────────────────────────────────────────────────────

function createTableToolbar(editor: Editor): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'tt-table-toolbar';
  bar.style.display = 'none';

  const sep = () => {
    const s = document.createElement('span');
    s.className = 'tt-tb-sep';
    return s;
  };
  const btn = (label: string, title: string, cmd: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tt-tb-btn';
    b.title = title;
    b.textContent = label;
    b.addEventListener('mousedown', (e) => { e.preventDefault(); cmd(); });
    return b;
  };

  bar.append(
    btn('+행↑', '위 행 추가', () => editor.chain().focus().addRowBefore().run()),
    btn('+행↓', '아래 행 추가', () => editor.chain().focus().addRowAfter().run()),
    btn('+열←', '왼쪽 열 추가', () => editor.chain().focus().addColumnBefore().run()),
    btn('+열→', '오른쪽 열 추가', () => editor.chain().focus().addColumnAfter().run()),
    sep(),
    btn('−행', '행 삭제', () => editor.chain().focus().deleteRow().run()),
    btn('−열', '열 삭제', () => editor.chain().focus().deleteColumn().run()),
    sep(),
    btn('병합', '선택 셀 병합', () => editor.chain().focus().mergeCells().run()),
    btn('분할', '셀 분할', () => editor.chain().focus().splitCell().run()),
    sep(),
    btn('헤더행', '헤더 행 토글', () => editor.chain().focus().toggleHeaderRow().run()),
    btn('헤더열', '헤더 열 토글', () => editor.chain().focus().toggleHeaderColumn().run()),
    sep(),
    btn('표 삭제', '표 전체 삭제', () => editor.chain().focus().deleteTable().run()),
  );
  return bar;
}

// ── Auto-scroll keep cursor visible ─────────────────────────────────────────

function ensureCursorVisible(editor: Editor) {
  try {
    const { from } = editor.state.selection;
    const coords = editor.view.coordsAtPos(from);
    const winH = window.innerHeight;
    const headerH = 64;
    const padBottom = 120;
    if (coords.bottom > winH - padBottom) {
      const delta = coords.bottom - (winH - padBottom);
      window.scrollBy({ top: delta, behavior: 'smooth' });
    } else if (coords.top < headerH + 20) {
      const delta = (headerH + 20) - coords.top;
      window.scrollBy({ top: -delta, behavior: 'smooth' });
    }
  } catch {}
}

// ── Text alignment (custom, no extra deps) ──────────────────────────────────
// Adds a `textAlign` attribute to paragraphs/headings, rendered as inline style.
const ALIGN_TYPES = ['paragraph', 'heading'];
const TextAlign = Extension.create({
  name: 'textAlign',
  addGlobalAttributes() {
    return [{
      types: ALIGN_TYPES,
      attributes: {
        textAlign: {
          default: null,
          parseHTML: (el: HTMLElement) => {
            const a = el.style.textAlign || el.getAttribute('align') || null;
            return a && a !== 'left' ? a : null;
          },
          renderHTML: (attrs: { textAlign?: string | null }) =>
            attrs.textAlign && attrs.textAlign !== 'left'
              ? { style: `text-align: ${attrs.textAlign}` }
              : {},
        },
      },
    }];
  },
  addCommands() {
    return {
      // @ts-expect-error — loose command typing
      setTextAlign: (alignment: string) => ({ commands }: any) =>
        ALIGN_TYPES.map((t) => commands.updateAttributes(t, { textAlign: alignment })).some(Boolean),
    } as any;
  },
});

// ── Text color (custom textStyle mark + color) ──────────────────────────────
const TextStyle = Mark.create({
  name: 'textStyle',
  parseHTML() {
    return [{ tag: 'span', getAttrs: (el: any) => (el.getAttribute('style') ? {} : false) }];
  },
  renderHTML({ HTMLAttributes }: any) {
    return ['span', HTMLAttributes, 0];
  },
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el: HTMLElement) => el.style.color || null,
        renderHTML: (attrs: { color?: string | null }) =>
          attrs.color ? { style: `color: ${attrs.color}` } : {},
      },
    };
  },
  addCommands() {
    return {
      // @ts-expect-error — loose command typing
      setColor: (color: string) => ({ chain }: any) =>
        chain().setMark('textStyle', { color }).run(),
      // @ts-expect-error — loose command typing
      unsetColor: () => ({ chain }: any) =>
        chain().setMark('textStyle', { color: null }).run(),
    } as any;
  },
});

// ── Bubble toolbar (appears when text is selected) ──────────────────────────
// Only Markdown-native formatting (round-trips cleanly): bold/italic/strike/
// code, H1–H3 (글자 크기), quote, lists, link.
function createBubbleToolbar(editor: Editor): { destroy: () => void } {
  const bar = document.createElement('div');
  bar.className = 'tt-bubble';
  bar.style.display = 'none';

  type Btn = { label: string; title: string; active?: () => boolean; run: () => void };
  const items: Array<Btn | 'sep'> = [
    { label: 'B', title: '굵게 (⌘B)', active: () => editor.isActive('bold'), run: () => editor.chain().focus().toggleBold().run() },
    { label: 'I', title: '기울임 (⌘I)', active: () => editor.isActive('italic'), run: () => editor.chain().focus().toggleItalic().run() },
    { label: 'S', title: '취소선', active: () => editor.isActive('strike'), run: () => editor.chain().focus().toggleStrike().run() },
    { label: '</>', title: '인라인 코드', active: () => editor.isActive('code'), run: () => editor.chain().focus().toggleCode().run() },
    'sep',
    { label: 'H1', title: '제목 1 (큰 글자)', active: () => editor.isActive('heading', { level: 1 }), run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: 'H2', title: '제목 2', active: () => editor.isActive('heading', { level: 2 }), run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: 'H3', title: '제목 3', active: () => editor.isActive('heading', { level: 3 }), run: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    'sep',
    { label: '❝', title: '인용', active: () => editor.isActive('blockquote'), run: () => editor.chain().focus().toggleBlockquote().run() },
    { label: '•', title: '글머리 목록', active: () => editor.isActive('bulletList'), run: () => editor.chain().focus().toggleBulletList().run() },
    { label: '1.', title: '번호 목록', active: () => editor.isActive('orderedList'), run: () => editor.chain().focus().toggleOrderedList().run() },
    { label: '↗', title: '링크', active: () => editor.isActive('link'), run: () => {
        const prev = (editor.getAttributes('link').href as string) || '';
        const url = window.prompt('링크 URL', prev);
        if (url === null) return;
        if (url === '') editor.chain().focus().extendMarkRange('link').unsetLink().run();
        else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
      } },
    'sep',
    { label: '⇤', title: '왼쪽 정렬', active: () => editor.isActive({ textAlign: 'left' }), run: () => (editor.chain().focus() as any).setTextAlign('left').run() },
    { label: '⇔', title: '가운데 정렬', active: () => editor.isActive({ textAlign: 'center' }), run: () => (editor.chain().focus() as any).setTextAlign('center').run() },
    { label: '⇥', title: '오른쪽 정렬', active: () => editor.isActive({ textAlign: 'right' }), run: () => (editor.chain().focus() as any).setTextAlign('right').run() },
  ];

  // Color swatches (V11 palette) + clear.
  const COLORS: Array<[string, string]> = [
    ['#f2f2f2', '기본 밝게'],
    ['#3fb950', '그린'],
    ['#d29922', '앰버'],
    ['#f85149', '레드'],
    ['#39c5cf', '시안'],
    ['#bc8cff', '퍼플'],
  ];

  const refs: Array<{ el: HTMLButtonElement; active?: () => boolean }> = [];
  for (const item of items) {
    if (item === 'sep') {
      const s = document.createElement('span');
      s.className = 'tt-bubble-sep';
      bar.appendChild(s);
      continue;
    }
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tt-bubble-btn';
    el.textContent = item.label;
    el.title = item.title;
    el.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
    el.addEventListener('click', (e) => { e.preventDefault(); item.run(); update(); });
    bar.appendChild(el);
    refs.push({ el, active: item.active });
  }

  // color swatches
  const sep = document.createElement('span');
  sep.className = 'tt-bubble-sep';
  bar.appendChild(sep);
  for (const [color, name] of COLORS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'tt-bubble-swatch';
    sw.title = `색상: ${name}`;
    sw.style.background = color;
    sw.addEventListener('mousedown', (e) => e.preventDefault());
    sw.addEventListener('click', (e) => { e.preventDefault(); (editor.chain().focus() as any).setColor(color).run(); update(); });
    bar.appendChild(sw);
  }
  const clr = document.createElement('button');
  clr.type = 'button';
  clr.className = 'tt-bubble-btn';
  clr.textContent = '×';
  clr.title = '색상 제거';
  clr.addEventListener('mousedown', (e) => e.preventDefault());
  clr.addEventListener('click', (e) => { e.preventDefault(); (editor.chain().focus() as any).unsetColor().run(); update(); });
  bar.appendChild(clr);

  document.body.appendChild(bar);

  function update() {
    const { selection } = editor.state;
    if (selection.empty || !editor.isFocused) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    let start, end;
    try {
      start = editor.view.coordsAtPos(selection.from);
      end = editor.view.coordsAtPos(selection.to);
    } catch { bar.style.display = 'none'; return; }
    const bw = bar.offsetWidth;
    const bh = bar.offsetHeight;
    let left = (start.left + end.right) / 2 - bw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
    let top = start.top - bh - 8;
    if (top < 8) top = end.bottom + 8;
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
    for (const r of refs) r.el.classList.toggle('is-active', !!r.active?.());
  }

  const onBlur = () => setTimeout(() => { if (!editor.isFocused) bar.style.display = 'none'; }, 120);
  editor.on('selectionUpdate', update);
  editor.on('transaction', update);
  editor.on('blur', onBlur);
  window.addEventListener('scroll', update, true);
  window.addEventListener('resize', update);

  return {
    destroy: () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
      editor.off('blur', onBlur);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      bar.remove();
    },
  };
}

// ── Editor factory ──────────────────────────────────────────────────────────

export function createBlogEditor(opts: BlogEditorOptions): BlogEditorHandle {
  const { element, initialMarkdown = '', apiBase, getAuthToken, onChange } = opts;

  // Wrapper structure: toolbar (sticky) on top, ProseMirror mount below
  element.innerHTML = '';
  const editorMount = document.createElement('div');
  editorMount.className = 'tt-editor-mount';
  element.appendChild(editorMount);

  async function uploadFile(file: File): Promise<string | null> {
    const fd = new FormData();
    fd.append('file', file);
    const token = getAuthToken();
    try {
      const res = await fetch(`${apiBase}/api/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const authMessage = res.status === 401
          ? '관리자 로그인이 만료되었습니다. 글 내용을 복사해 둔 뒤 다시 로그인해주세요.'
          : res.status === 403
            ? '관리자 권한이 확인되지 않아 업로드할 수 없습니다. 관리자 계정으로 다시 로그인해주세요.'
            : '';
        throw new Error(authMessage || data.error || `HTTP ${res.status}`);
      }
      return data.url as string;
    } catch (err: any) {
      alert('업로드 실패: ' + err.message);
      return null;
    }
  }

  function pickAndUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return;
      const url = await uploadFile(f);
      if (url) editor.chain().focus().setImage({ src: url }).run();
    });
    input.click();
  }

  const editor = new Editor({
    element: editorMount,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        codeBlock: false,
      }),
      LanguageCodeBlock.configure({
        languageClassPrefix: 'language-',
        enableTabIndentation: true,
        tabSize: 4,
      }),
      ResizableImage.configure({ inline: false, allowBase64: false, HTMLAttributes: { class: 'tt-img' } }),
      TextAlign,
      TextStyle,
      Link.configure({ openOnClick: false, HTMLAttributes: { rel: 'noopener', target: '_blank' } }),
      Placeholder.configure({
        placeholder: ({ node }) => {
          if (node.type.name === 'heading') return '제목을 입력하세요';
          return "본문을 작성하세요. '/' 입력으로 블록 메뉴 열기";
        },
      }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      createSlashExtension(pickAndUpload),
    ],
    content: contentToHtml(initialMarkdown),
    editorProps: {
      // `prose` makes the editing surface render with the same V11 article
      // styling as the published post (live WYSIWYG fidelity).
      attributes: { class: 'prose tiptap-editor-content' },
      handlePaste: (_view, event) => {
        const clipboard = (event as ClipboardEvent).clipboardData;
        const items = clipboard?.items;
        if (!items) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            event.preventDefault();
            const file = item.getAsFile();
            if (file) uploadFile(file).then(url => {
              if (url) editor.chain().focus().setImage({ src: url }).run();
            });
            return true;
          }
        }
        const plain = clipboard?.getData('text/plain') || '';
        if (looksLikeMarkdownPaste(plain)) {
          event.preventDefault();
          editor.chain().focus().insertContent(contentToHtml(plain)).run();
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const dt = (event as DragEvent).dataTransfer;
        if (!dt?.files?.length) return false;
        let handled = false;
        for (const file of Array.from(dt.files)) {
          if (file.type.startsWith('image/')) {
            event.preventDefault();
            uploadFile(file).then(url => {
              if (url) editor.chain().focus().setImage({ src: url }).run();
            });
            handled = true;
          }
        }
        return handled;
      },
    },
    onUpdate: ({ editor }) => {
      onChange?.(htmlToMd(editor.getHTML()));
      ensureCursorVisible(editor);
    },
    onSelectionUpdate: ({ editor }) => {
      ensureCursorVisible(editor);
    },
  });

  // Mount table toolbar at top of wrapper, show/hide based on cursor
  const toolbar = createTableToolbar(editor);
  element.insertBefore(toolbar, editorMount);
  const refreshToolbar = () => {
    toolbar.style.display = editor.isActive('table') ? 'flex' : 'none';
  };
  editor.on('selectionUpdate', refreshToolbar);
  editor.on('update', refreshToolbar);
  editor.on('focus', refreshToolbar);
  refreshToolbar();

  // Notion-style floating toolbar shown when text is selected.
  const bubble = createBubbleToolbar(editor);

  return {
    editor,
    // Body is now stored as HTML (supports alignment/color). Legacy markdown
    // posts are auto-converted to HTML on first edit.
    getMarkdown: () => editor.getHTML(),
    setMarkdown: (md: string) => editor.commands.setContent(contentToHtml(md), false),
    destroy: () => { bubble.destroy(); editor.destroy(); },
  };
}
