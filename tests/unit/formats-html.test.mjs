// HTML extraction without a DOM: dropped elements, entities, structure and character encodings.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeHtmlBytes, decodeHtmlEntities, htmlToText } from '../../src/js/rag/formats/html.js';
import { extractText, ParseError } from '../../src/js/rag/parser.js';

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Harbor Library &ndash; Plan</title>
  <style>body { color: red } h1::before { content: "<p>not text</p>" }</style>
  <script>document.write("<p>injected</p>"); if (a < b && c > d) {}</script>
  <script type="application/ld+json">{"name": "hidden"}</script>
</head>
<body>
  <!-- a comment with <p>markup</p> -->
  <nav><a href="/">Home</a> · <a href="/about">About</a></nav>
  <h1>Harbor   Library
      Renovation</h1>
  <p>The reading room reopens on <b>3&nbsp;March 2027</b>.
     The approved budget is 240,000&nbsp;EUR&#46;</p>
  <h2>Milestones</h2>
  <ul>
    <li>Design review in May
      <ul><li>Two bids compared</li><li>One bid accepted</ul>
    <li><p>Contract signed in June</p><p>with a second paragraph</p></li>
  </ul>
  <ol start="3"><li>Order the shelves<li>Install the lighting</ol>
  <table>
    <caption>Team</caption>
    <thead><tr><th>Role</th><th>Name</th><th>Hours</th></tr></thead>
    <tbody>
      <tr><td>Lead</td><td>Ana <i>Ruiz</i></td><td>120</td>
      <tr><td>Architect</td><td>Ben<br>Okafor</td><td>80</td></tr>
    </tbody>
  </table>
  <pre>
line 1
    indented line 2</pre>
  <template><p>template content</p></template>
  <noscript>Please enable scripts</noscript>
  <svg viewBox="0 0 10 10"><text>chart label</text><svg><text>inner</text></svg></svg>
  <p>Caf&eacute; &amp co &copy 2027 &unknown; &#x1F600; &#150; &#0;</p>
  <p>a &lt;b&gt; <img src="x.png" alt="image"> c</p>
</body>
</html>`;

describe('htmlToText', () => {
  it('keeps headings, paragraphs, lists, tables and preformatted text and drops scripts, styles and hidden content', () => {
    assert.equal(
      htmlToText(PAGE),
      [
        'Home · About',
        '# Harbor Library Renovation',
        'The reading room reopens on 3 March 2027. The approved budget is 240,000 EUR.',
        '## Milestones',
        '- Design review in May\n  - Two bids compared\n  - One bid accepted\n- Contract signed in June\n  with a second paragraph\n3. Order the shelves\n4. Install the lighting',
        'Team',
        'Role: Lead; Name: Ana Ruiz; Hours: 120\nRole: Architect; Name: Ben Okafor; Hours: 80',
        'line 1\n    indented line 2',
        'Café & co © 2027 &unknown; 😀 – �',
        'a <b> c',
      ].join('\n\n'),
    );
  });

  it('uses the title as the first heading only when the page has no h1', () => {
    assert.equal(htmlToText('<title>Notes &amp; plans</title><p>Body</p>'), '# Notes & plans\n\nBody');
    assert.equal(htmlToText('<title>Page</title><h1>Real heading</h1>'), '# Real heading');
    assert.equal(htmlToText('<title>Only a title</title>'), '# Only a title');
  });

  it('copes with broken markup: unclosed elements, stray brackets, unterminated comments', () => {
    assert.equal(htmlToText('<p>3 < 5 and 7 > 2<p>next'), '3 < 5 and 7 > 2\n\nnext');
    assert.equal(htmlToText('<div>open<table><tr><td>a<td>b<tr><td>c<td>d'), 'open\n\na: c; b: d');
    assert.equal(htmlToText('<table><tr><td>1<td>2<tr><td>3'), '1 | 2\n3');
    assert.equal(htmlToText('<p>before<!-- never closed <p>hidden'), 'before');
    assert.equal(htmlToText('<script>never closed <p>hidden'), '');
    assert.equal(htmlToText('<svg/><p>after a self-closing svg</p>'), 'after a self-closing svg');
    assert.equal(htmlToText('plain text without tags'), 'plain text without tags');
  });

  it('flattens a table nested in a cell and numbers ordered lists by value', () => {
    assert.equal(htmlToText('<table><tr><th>Key</th><th>Detail</th></tr><tr><td>A</td><td><table><tr><td>x</td><td>y</td></tr></table></td></tr></table>'), 'Key: A; Detail: x | y');
    assert.equal(htmlToText('<ol><li value="10">ten<li>eleven</ol>'), '10. ten\n11. eleven');
    assert.equal(htmlToText('<li>orphan item'), '- orphan item');
    assert.equal(htmlToText('<li>orphan</li><ul><li>real</li></ul>'), '- orphan\n- real');
  });

  it('decodes entities like a browser', () => {
    assert.equal(decodeHtmlEntities('&amp;&lt;&gt;&quot;&apos;&nbsp;&euro;&hellip;'), '&<>"\' €…');
    assert.equal(decodeHtmlEntities('&ampx &copy2027 &notanentity &Auml;&szlig'), '&x ©2027 ¬anentity Äß');
    assert.equal(decodeHtmlEntities('&#8364;&#x20ac;&#X20AC;&#128;&#x9f;&#xD800;&#1114112;'), '€€€€Ÿ��');
  });

  it('reads the encoding from a byte order mark or a meta charset', () => {
    const latin = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1252"><p>Gr'), 0xfc, 0xdf, 0x65, 0x20, 0x80]);
    assert.equal(htmlToText(decodeHtmlBytes(latin)), 'Grüße €');
    const equiv = new Uint8Array([...new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1"><p>K'), 0xf6, 0x6c, 0x6e]);
    assert.equal(htmlToText(decodeHtmlBytes(equiv)), 'Köln');
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...'<p>Ö</p>'].flatMap((ch) => [ch.charCodeAt(0), 0])]);
    assert.equal(htmlToText(decodeHtmlBytes(utf16)), 'Ö');
    assert.equal(htmlToText(decodeHtmlBytes(new TextEncoder().encode('<meta charset="no-such-encoding"><p>Grüße'))), 'Grüße');
    assert.equal(htmlToText(decodeHtmlBytes(new TextEncoder().encode('﻿<meta charset="windows-1252"><p>Grüße'))), 'Grüße', 'the UTF-8 byte order mark wins');
  });

  it('stops at the text limit', () => {
    assert.throws(() => htmlToText(`<p>${'word '.repeat(200)}</p>`.repeat(10), { maxChars: 1000 }), (err) => err instanceof ParseError && err.code === 'too_large');
  });
});

describe('extractText with HTML files', () => {
  it('reads .html and .htm files and records them as html', async () => {
    for (const name of ['page.html', 'PAGE.HTM']) {
      const res = await extractText(new File([PAGE], name));
      assert.equal(res.kind, 'html');
      assert.match(res.text, /^Home · About\n\n# Harbor Library Renovation\n/);
      assert.doesNotMatch(res.text, /injected|hidden|template content|chart label|not text|Please enable/);
    }
  });

  it('reports a page without visible text as empty', async () => {
    await assert.rejects(extractText(new File(['<script>only()</script><style>p{}</style>'], 'blank.html')), (err) => err instanceof ParseError && err.code === 'empty');
  });
});
