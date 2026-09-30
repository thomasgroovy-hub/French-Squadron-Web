/**
 * Renders the subset of Discord markdown used by the documentation blocks and
 * the forms.
 *
 * The order of operations is the whole point: the raw text is escaped to HTML
 * *before* any markdown transformation runs, so nothing an author types can ever
 * produce a tag. Every replacement below therefore only ever inserts markup of
 * our own around already-escaped text.
 *
 * Two entry points share that guarantee:
 *  - `renderDiscordMarkdown` is block level (paragraphs, lists, quotes, code
 *    blocks) and is used where the text is the whole content of a page;
 *  - `renderDiscordInline` keeps everything on one line and is used inside an
 *    existing element — a question label, a title, a card subtitle.
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * The spoiler is a real `<button>` rather than a clickable `<span>`: it is then
 * reachable with the Tab key, announced as an interactive element, and it can
 * never submit the surrounding form. It is revealed by CSS alone (`:focus`), so
 * hiding it costs no JavaScript at all. No `aria-label` on purpose: a screen
 * reader reads a spoiler's text whatever the styling, and a label saying
 * « révéler » would only add a lie to a technique that is unreadable anyway.
 */
const SPOILER_OPEN = '<button type="button" class="md-spoiler" title="Cliquer pour révéler">';
const SPOILER_CLOSE = '</button>';

/**
 * Inline passes, applied to text that is already escaped. The caller has the
 * responsibility of lifting code blocks out beforehand if it supports them.
 */
function applyInlinePasses(text) {
  return text
    .replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/\|\|([\s\S]+?)\|\|/g, `${SPOILER_OPEN}$1${SPOILER_CLOSE}`)
    // Discord only emphasises a run with no space just inside the delimiters, so
    // `a * b * c` and `snake_case_word` stay literal instead of turning the middle
    // of a sentence italic.
    .replace(/(?<![\w*])\*(?!\*)([^*\s](?:[^*\n]*?[^*\s])?)\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<![\w_])_([^_\s](?:[^_\n]*?[^\s_])?)_(?!_)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/**
 * Code blocks are lifted out first and put back at the very end, so the inline
 * passes cannot rewrite their content. The sentinel is built with
 * `String.fromCharCode(0)` rather than a `NUL` escape, to keep this file free of
 * a raw NUL byte: a NUL cannot survive a textarea post, so an author can never
 * forge a placeholder.
 */
const NUL = String.fromCharCode(0);
const CODE_BLOCK_OPEN = NUL + 'CODEBLOCK';
const CODE_BLOCK_CLOSE = NUL;
const CODE_BLOCK_PATTERN = new RegExp(NUL + 'CODEBLOCK(\\d+)' + NUL, 'g');
/** A line holding nothing but a placeholder: the block stands on its own. */
const CODE_BLOCK_LINE = new RegExp('^' + NUL + 'CODEBLOCK(\\d+)' + NUL + '$');

export function renderDiscordMarkdown(rawText) {
  if (!rawText) return '';

  const codeBlocks = [];
  let text = String(rawText).replace(/```([\s\S]*?)```/g, (m, code) => {
    codeBlocks.push(`<pre class="md-code"><code>${escapeHtml(code.trim())}</code></pre>`);
    return `${CODE_BLOCK_OPEN}${codeBlocks.length - 1}${CODE_BLOCK_CLOSE}`;
  });

  text = applyInlinePasses(escapeHtml(text));

  const lines = text.split('\n');
  const html = [];
  let listBuffer = [];
  let listType = null;
  const flushList = () => {
    if (!listBuffer.length) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    html.push(`<${tag} class="md-list">${listBuffer.map((i) => `<li>${i}</li>`).join('')}</${tag}>`);
    listBuffer = []; listType = null;
  };

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    // The `>` was already escaped to `&gt;` above, so a blockquote marker is
    // matched in its escaped form. Text a user typed as the literal characters
    // `&gt;` came out as `&amp;gt;` and cannot match here, so there is no way to
    // fake a quote.
    const quote = line.match(/^\s*&gt;\s?(.*)$/);
    const codeOnly = line.trim().match(CODE_BLOCK_LINE);
    if (bullet) { if (listType !== 'ul') flushList(); listType = 'ul'; listBuffer.push(bullet[1]); }
    else if (numbered) { if (listType !== 'ol') flushList(); listType = 'ol'; listBuffer.push(numbered[1]); }
    else {
      flushList();
      // A fence standing on its own line becomes a sibling of the paragraphs,
      // not a `<pre>` wrapped in a `<p>`, which is not valid HTML.
      if (codeOnly) html.push(codeBlocks[Number(codeOnly[1])]);
      else if (quote) html.push(`<blockquote class="md-quote">${quote[1]}</blockquote>`);
      else if (line.trim()) html.push(`<p class="md-text">${line}</p>`);
    }
  }
  flushList();

  return html.join('').replace(CODE_BLOCK_PATTERN, (m, i) => codeBlocks[Number(i)]);
}

/**
 * Same syntax, no block structure: the result drops inside an existing element
 * (a `<h2>`, a card subtitle) where a `<p>` would be invalid, and where a list
 * would fight with the surrounding layout. Line breaks are kept, since a form
 * description is often typed as several lines.
 */
export function renderDiscordInline(rawText) {
  if (!rawText) return '';
  return applyInlinePasses(escapeHtml(String(rawText))).replace(/\n/g, '<br>');
}

/**
 * Plain text version, for the places that cannot hold markup: an `aria-label`, a
 * `title`, a `placeholder`. Keeping the raw asterisks there would make a screen
 * reader read "étoile étoile point d'interrogation".
 */
export function stripDiscordMarkdown(rawText) {
  if (!rawText) return '';
  return String(rawText)
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\|\|([\s\S]+?)\|\|/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(?!\*)([^*\s](?:[^*\n]*?[^*\s])?)\*(?!\*)/g, '$1')
    .replace(/(?<![\w_])_([^_\s](?:[^_\n]*?[^\s_])?)_(?!_)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
