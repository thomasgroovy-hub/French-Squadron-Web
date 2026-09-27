import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDiscordMarkdown } from '../src/utils/discord-markdown.js';

test('empty markdown renders as an empty string', () => {
  assert.equal(renderDiscordMarkdown(''), '');
  assert.equal(renderDiscordMarkdown(null), '');
  assert.equal(renderDiscordMarkdown(undefined), '');
});

test('Discord inline formatting renders the supported delimiters', () => {
  const html = renderDiscordMarkdown('**bold** *italic* __underline__ ~~strike~~ ||spoiler|| `code`');

  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<u>underline<\/u>/);
  assert.match(html, /<s>strike<\/s>/);
  assert.match(html, /<span class="doc-spoiler" onclick="this\.classList\.add\('is-revealed'\)">spoiler<\/span>/);
  assert.match(html, /<code class="doc-inline-code">code<\/code>/);
});

test('lists and block quotes become semantic blocks', () => {
  const html = renderDiscordMarkdown('- one\n- two\n\n1. first\n2. second\n\n> quoted');

  assert.match(html, /<ul class="doc-md-list"><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol class="doc-md-list"><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote class="doc-quote">quoted<\/blockquote>/);
});

test('fenced code is escaped and rendered as a sibling block', () => {
  const html = renderDiscordMarkdown('```<script>alert("x")</script>```');

  assert.equal(html, '<pre class="doc-code">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</pre>');
  assert.doesNotMatch(html, /<p class="doc-text"><pre/);
  assert.doesNotMatch(html, /<script>/);
});

test('raw HTML is escaped and only absolute HTTP(S) markdown links become anchors', () => {
  const html = renderDiscordMarkdown('<img src=x onerror=alert(1)>\n[jump](javascript:alert(1))\n[site](https://example.test/?a=1&b=2)');

  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<a href="javascript:/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /\[jump\]\(javascript:alert\(1\)\)/);
  assert.match(html, /<a href="https:\/\/example\.test\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">site<\/a>/);
});

test('ambiguous underscores and spaced asterisks remain literal', () => {
  const html = renderDiscordMarkdown('snake_case_word and a * b * c, but _italic_ works');

  assert.match(html, /snake_case_word and a \* b \* c, but <em>italic<\/em> works/);
});
