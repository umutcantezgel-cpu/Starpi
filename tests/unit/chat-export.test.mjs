// Chat export: the JSON schema, the Markdown layout and the file names.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHAT_EXPORT_SCHEMA, chatToJson, chatToMarkdown, exportFileName } from '../../src/js/chat-export.js';

/** @type {import('../../src/js/chat-export.js').ExportTurn[]} */
const TURNS = [
  { role: 'user', content: 'Write hello world in Python.\n\n[notes.md]', createdAt: '2026-10-14T09:00:00.000Z', engine: null, model: null, chatMode: 'free' },
  {
    role: 'assistant',
    content: "Here you go:\n\n```python\nprint('hi')\n```\n",
    createdAt: '2026-10-14T09:00:02.000Z',
    engine: 'client',
    model: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    chatMode: 'free',
  },
];

const META = { sessionId: 'starpi_0f8fad5b-d9cb-469f-a165-70867728950e', exportedAt: '2026-10-14T09:05:00.000Z', version: '2.1.0', locale: 'en' };

describe('chatToJson', () => {
  it('has schema starpi.chat/v1, the generator, the session and the messages in order, with no internal fields', () => {
    const withInternal = TURNS.map((t) => ({ ...t, localOnly: true, shown: 'x' }));
    const text = chatToJson(withInternal, META);
    assert.ok(text.endsWith('}\n'));
    const doc = JSON.parse(text);
    assert.equal(CHAT_EXPORT_SCHEMA, 'starpi.chat/v1');
    assert.deepEqual(Object.keys(doc), ['schema', 'generator', 'sessionId', 'exportedAt', 'locale', 'messages']);
    assert.equal(doc.schema, 'starpi.chat/v1');
    assert.deepEqual(doc.generator, { name: 'starpi', version: '2.1.0' });
    assert.equal(doc.sessionId, META.sessionId);
    assert.deepEqual(doc.messages, TURNS);
    assert.doesNotMatch(text, /localOnly|shown/);
  });
});

describe('chatToMarkdown', () => {
  it('has the title, one heading per speaker with the engine label, and keeps code fences intact', () => {
    const md = chatToMarkdown(TURNS, {
      title: 'Starpi chat',
      subtitle: 'Exported on 14 October 2026 · 2 messages',
      user: 'You',
      assistant: (t) => `Starpi · ${t.engine}`,
    });
    assert.equal(
      md,
      "# Starpi chat\n\n_Exported on 14 October 2026 · 2 messages_\n\n## You\n\nWrite hello world in Python.\n\n[notes.md]\n\n## Starpi · client\n\nHere you go:\n\n```python\nprint('hi')\n```\n",
    );
  });

  it('closes a code fence that a cut-off answer left open', () => {
    const cut = [{ ...TURNS[1], content: '```js\nconst a = 1;' }, { ...TURNS[0], content: 'Next' }];
    const md = chatToMarkdown(cut, { title: 'T', subtitle: 'S', user: 'You', assistant: () => 'Starpi' });
    assert.match(md, /const a = 1;\n```\n\n## You\n\nNext\n$/);
  });
});

describe('exportFileName', () => {
  it('is dated and safe', () => {
    assert.equal(exportFileName(META.sessionId, META.exportedAt, 'md'), 'starpi-chat-2026-10-14-0f8fad5b.md');
    assert.equal(exportFileName('starpi_../../x?y', META.exportedAt, 'json'), 'starpi-chat-2026-10-14-xy.json');
    assert.equal(exportFileName('', '2026/10/14', 'json'), 'starpi-chat-20261014.json');
  });
});
