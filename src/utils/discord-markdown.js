/**
 * Renders the subset of Discord markdown the documentation blocks support.
 *
 * The order of operations is the whole point: the raw text is escaped to HTML
 * *before* any markdown transformation runs, so nothing an author types can ever
 * produce a tag. Every replacement below therefore only ever inserts markup of
 * our own around already-escaped text.
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
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
    codeBlocks.push(`<pre class="doc-code">${escapeHtml(code.trim())}</pre>`);
    return `${CODE_BLOCK_OPEN}${codeBlocks.length - 1}${CODE_BLOCK_CLOSE}`;
  });

  text = escapeHtml(text);

  text = text
    .replace(/`([^`\n]+)`/g, '<code class="doc-inline-code">$1</code>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/\|\|(.+?)\|\|/g, '<span class="doc-spoiler" onclick="this.classList.add(\'is-revealed\')">$1</span>')
    // Discord only emphasises a run with no space just inside the delimiters, so
    // `a * b * c` and `snake_case_word` stay literal instead of turning the middle
    // of a sentence italic.
    .replace(/(?<![\w*])\*(?!\*)([^*\s](?:[^*\n]*?[^*\s])?)\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<![\w_])_([^_\s](?:[^_\n]*?[^\s_])?)_(?!_)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const lines = text.split('\n');
  const html = [];
  let listBuffer = [];
  let listType = null;
  const flushList = () => {
    if (!listBuffer.length) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    html.push(`<${tag} class="doc-md-list">${listBuffer.map((i) => `<li>${i}</li>`).join('')}</${tag}>`);
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
      else if (quote) html.push(`<blockquote class="doc-quote">${quote[1]}</blockquote>`);
      else if (line.trim()) html.push(`<p class="doc-text">${line}</p>`);
    }
  }
  flushList();

  return html.join('').replace(CODE_BLOCK_PATTERN, (m, i) => codeBlocks[Number(i)]);
}
