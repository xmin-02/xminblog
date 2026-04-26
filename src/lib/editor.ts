/**
 * Block-style rich editor for blog posts.
 * Storage stays as Markdown; this module handles MD ↔ HTML round-trip.
 *
 * Features
 *   - Tiptap-based block editor (Notion-like UX)
 *   - Slash commands ("/제목", "/표", etc.)
 *   - Image paste / drop → POST /api/upload → insert as image
 *   - Tables, lists, code blocks, blockquote, hr, link
 */

import { Editor, Extension } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
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

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});
turndown.use(gfm);
// Preserve image alt + url
turndown.addRule('img', {
  filter: 'img',
  replacement: (_content, node) => {
    const el = node as HTMLImageElement;
    const alt = (el.getAttribute('alt') ?? '').replace(/[\[\]]/g, '');
    const src = el.getAttribute('src') ?? '';
    return src ? `![${alt}](${src})` : '';
  },
});

export function mdToHtml(md: string): string {
  return marked.parse(md ?? '', { async: false }) as string;
}
export function htmlToMd(html: string): string {
  return turndown.turndown(html ?? '');
}

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

// ── Editor factory ──────────────────────────────────────────────────────────

export function createBlogEditor(opts: BlogEditorOptions): BlogEditorHandle {
  const { element, initialMarkdown = '', apiBase, getAuthToken, onChange } = opts;

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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
      }),
      Image.configure({ inline: false, allowBase64: false, HTMLAttributes: { class: 'tt-img' } }),
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
    content: mdToHtml(initialMarkdown),
    editorProps: {
      attributes: { class: 'tiptap-editor-content' },
      handlePaste: (_view, event) => {
        const items = (event as ClipboardEvent).clipboardData?.items;
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
    },
  });

  return {
    editor,
    getMarkdown: () => htmlToMd(editor.getHTML()),
    setMarkdown: (md: string) => editor.commands.setContent(mdToHtml(md), false),
    destroy: () => editor.destroy(),
  };
}
