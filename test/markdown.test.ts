import assert from 'node:assert/strict'
import { it } from 'vitest'

import {
  escapeInlineCode,
  escapeMarkdownInlineText,
  escapeMarkdownText,
  escapeMarkdownUrl,
  escapeWikilinkAlias,
  escapeWikilinkTarget,
  normalizeExternalUrl,
} from '../src/markdown.ts'

it('escapes Markdown punctuation without changing ordinary Unicode text', () => {
  assert.equal(
    escapeMarkdownText('Привет, \\ * _ [ ] < > ` # + - ! | ~ = { } ( )'),
    'Привет, \\\\ \\* \\_ \\[ \\] \\< \\> \\` \\# \\+ \\- \\! \\| \\~ \\= \\{ \\} \\( \\)',
  )
  assert.equal(escapeMarkdownText('ordinary.text: café'), 'ordinary.text: café')
})

it('escapes ordered-list markers and block syntax after multiline breaks', () => {
  assert.equal(
    escapeMarkdownText('first\n# heading\n- item\n1. item\n> quote'),
    'first\n\\# heading\n\\- item\n1\\. item\n\\> quote',
  )
})

it('escapes math, comments, entities, and parenthesized ordered markers literally', () => {
  assert.equal(escapeMarkdownText('$x$ and %%hidden%% and &copy;'), '\\$x\\$ and \\%\\%hidden\\%\\% and \\&copy;')
  assert.equal(escapeMarkdownText('1) item\n22. item'), '1\\) item\n22\\. item')
})

it('encodes code-block indentation on initial and continuation lines', () => {
  assert.equal(
    escapeMarkdownText('    initial\nnext\n\tTabbed\n    final'),
    '&#32;   initial\nnext\n&#9;Tabbed\n&#32;   final',
  )
})

it('normalizes inline labels and external URL schemes', () => {
  assert.equal(escapeMarkdownInlineText('first\r\nsecond\n*third*'), 'first second \\*third\\*')
  assert.equal(normalizeExternalUrl('example.com/docs'), 'https://example.com/docs')
  assert.equal(normalizeExternalUrl('//example.com/docs'), 'https://example.com/docs')
  assert.equal(normalizeExternalUrl('mailto:user@example.com'), 'mailto:user@example.com')
  assert.equal(normalizeExternalUrl('http://example.com'), 'http://example.com')
  assert.equal(normalizeExternalUrl('HTTPS://example.com'), 'HTTPS://example.com')
})

it('rejects unsafe and unsupported external URL schemes', () => {
  for (const url of [
    'javascript:alert(1)',
    'DATA:text/html,script',
    'file:///etc/passwd',
    'ftp://example.com/file',
  ]) {
    assert.throws(() => normalizeExternalUrl(url), /unsupported external URL scheme/iu)
  }
})

it('uses safe code-span delimiters and renders embedded newlines as spaces', () => {
  assert.equal(escapeInlineCode('a * b'), '`a * b`')
  assert.equal(escapeInlineCode('a ` b'), '``a ` b``')
  assert.equal(escapeInlineCode('`tick`'), '`` `tick` ``')
  assert.equal(escapeInlineCode('first\nsecond'), '`first second`')
})

it('escapes external URL delimiters while retaining a valid destination', () => {
  assert.equal(
    escapeMarkdownUrl('https://example.com/a b_(c)?x=<tag>\\'),
    '<https://example.com/a b_(c)?x=%3Ctag%3E%5C>',
  )
})

it('escapes wikilink targets and aliases, including multiline aliases', () => {
  assert.equal(escapeWikilinkTarget('_trash/A#B[1].md'), '_trash/A\\#B\\[1\\]')
  assert.equal(escapeWikilinkAlias('a | b ]\nnext'), 'a \\| b \\] next')
})
