// rehype-figure: wrap every markdown <img> in the V11 terminal frame.
// Plain .md can't use <Content components={{ img: Figure }} /> (mdx-only), so we
// transform <img> nodes into the same HAST the Figure.astro component renders.
// Classes match global.css (.figure/.imgframe/.bar/.dots/.img/.fig).

function fileFrom(u) {
  if (!u) return 'image';
  try {
    return decodeURIComponent(String(u).split('/').pop().split('?')[0]);
  } catch {
    return String(u).split('/').pop();
  }
}
function extFrom(u) {
  if (!u) return 'img';
  const e = (String(u).split('.').pop() || '').split('?')[0].toLowerCase();
  return e && e.length <= 5 ? e : 'img';
}
function el(tagName, properties, children = []) {
  return { type: 'element', tagName, properties, children };
}
function text(value) {
  return { type: 'text', value };
}

function figureFor(img) {
  const props = img.properties || {};
  const src = props.src || '';
  const alt = typeof props.alt === 'string' ? props.alt : '';
  const rawTitle = String(props.title || '');
  const file = fileFrom(src);
  const fmt = extFrom(src);
  // Explicit width persisted by the editor as a `w=NNN` token in the title.
  const wMatch = rawTitle.match(/w=(\d+)/);
  const width = wMatch ? parseInt(wMatch[1], 10) : null;
  const title = rawTitle.replace(/\s*w=\d+\s*/, ' ').trim();
  const figLabel = /^fig/i.test(title) ? title : '';

  const bar = el('div', { className: ['bar'] }, [
    el('span', { className: ['dots'] }, [el('i', {}), el('i', {}), el('i', {})]),
    el('span', { className: ['file'] }, [text(file)]),
    el('span', { className: ['meta'] }, [text(fmt), el('span', { 'data-res': true, hidden: true })]),
  ]);

  const image = el('img', {
    className: ['img'],
    src,
    alt,
    loading: 'lazy',
    decoding: 'async',
  });

  const frameProps = { className: ['imgframe'] };
  if (width) frameProps.style = `max-width:${width}px`;
  const frame = el('div', frameProps, [bar, image]);
  const children = [frame];

  if (alt) {
    const capKids = [];
    if (figLabel) capKids.push(el('span', { className: ['fig'] }, [text(figLabel)]));
    capKids.push(text((figLabel ? ' ' : '') + alt));
    children.push(el('figcaption', {}, capKids));
  }

  return el('figure', { className: ['figure'] }, children);
}

function isImg(node) {
  return node && node.type === 'element' && node.tagName === 'img';
}
function isWhitespace(node) {
  return node && node.type === 'text' && !node.value.trim();
}

export default function rehypeFigure() {
  return function transform(tree) {
    function walk(node) {
      if (!node || !Array.isArray(node.children)) return;
      const out = [];
      for (const child of node.children) {
        // A paragraph that holds only image(s) → unwrap to figures (avoid <figure> inside <p>).
        if (child.type === 'element' && child.tagName === 'p') {
          const imgs = child.children.filter(isImg);
          const others = child.children.filter((c) => !isImg(c) && !isWhitespace(c));
          if (imgs.length && others.length === 0) {
            for (const im of imgs) out.push(figureFor(im));
            continue;
          }
        }
        if (isImg(child)) {
          out.push(figureFor(child));
          continue;
        }
        walk(child);
        out.push(child);
      }
      node.children = out;
    }
    walk(tree);
  };
}
