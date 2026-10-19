// @ts-check
// Modules `ask` and `chat`: questions to the companion, answered by the engine (engine.js) and
// always through the sentence gate of @starpi/core.
//   POST   /v1/ask                           member  { question, mode?, dataClass?, documents?, notes?, feeds? }
//                                                    -> { answer } in one JSON answer
//   POST   /v1/chat                          member  { question, conversation?, mode?, dataClass?, documents?,
//                                                    notes?, feeds?, tools? } -> server-sent events:
//          start {conversation, turn}, sources {...}, unit {text, cites, kind} (as units are released),
//          reset {withdrawn}, tool {tool, state}, approval {...}, done {conversation, turn, answer},
//          error {code}; the kernel ends every stream with `audit` (the signed head)
//   GET    /v1/chat/conversations            member  the conversations, most recent first
//   GET    /v1/chat/conversations/:id        member  one conversation with its turns
//   PUT    /v1/chat/conversations/:id        member  { title } renames it
//   DELETE /v1/chat/conversations/:id        member  deletes it with every turn
// `mode` is `sources` (default: answer from the companion's documents, notes and feed readings,
// every number checked against the source a sentence cites) or `free` (general knowledge; the gate
// still withholds links and characters outside its allowlist). `dataClass` defaults to personal.
// Tools of connectors are offered only in the chat and only when `tools` is true.
// Configuration (`modules.ask`, `modules.chat`): { "maxTokens": 1500, "historyTurns": 6 } (history: chat only).
import { text } from '../contracts/check.js';
import { DATA_CLASSES, isDataClass, strictest } from '../contracts/data-classes.js';
import { codeOf, fail } from '../lib/errors.js';
import { actorOf, bodyOf, checkBody, intIn, moduleConfig, notFound, pushStream } from '../setup/kit.js';
import { createAnswerEngine, MODES } from './engine.js';
import { CHATS_NAMESPACE, createChatStore } from './store.js';

export const MAX_QUESTION_CHARS = 8000;

/** @param {unknown} v */
const modeRule = (v) => (MODES.includes(/** @type {any} */ (v)) ? null : `one of ${MODES.join(', ')}`);
/** @param {unknown} v */
const classRule = (v) => (isDataClass(v) ? null : `one of ${DATA_CLASSES.join(', ')}`);
/** @param {unknown} v */
const boolRule = (v) => (typeof v === 'boolean' ? null : 'true or false');
/** @param {unknown} v */
const documentsRule = (v) => (Array.isArray(v) && v.length <= 50 && v.every((d) => typeof d === 'string' && /^doc-[0-9a-f-]{36}$/.test(d)) ? null : 'a list of up to 50 document ids');

const QUESTION_FIELDS = Object.freeze({ question: text(MAX_QUESTION_CHARS), mode: modeRule, dataClass: classRule, documents: documentsRule, notes: boolRule, feeds: boolRule });

/**
 * The parts of a question request every route shares.
 * @param {Record<string, unknown>} body
 */
function questionOf(body) {
  return {
    question: /** @type {string} */ (body.question).trim(),
    mode: /** @type {'sources' | 'free'} */ (body.mode ?? 'sources'),
    dataClass: /** @type {import('../contracts/data-classes.js').DataClass} */ (body.dataClass ?? 'personal'),
    documents: /** @type {string[] | undefined} */ (body.documents) ?? null,
    notes: body.notes !== false,
    feeds: body.feeds !== false,
  };
}

/**
 * Module `ask`: one question, one JSON answer.
 * @param {{ hub: import('../setup/hub.js').Hub }} deps
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createAskModule({ hub }) {
  /** @type {import('./engine.js').AnswerEngine | null} */
  let engine = null;
  let settings = { maxTokens: 1500 };
  return {
    id: 'ask',
    version: '1.0.0',
    title: 'Questions with checked answers',
    routes: [
      {
        method: 'POST',
        path: '/',
        access: 'member',
        maxBody: 64 * 1024,
        async handler(req) {
          if (!engine) throw fail('module_stopped', 'questions are not taken now', { status: 503 });
          const body = bodyOf(req);
          checkBody(body, QUESTION_FIELDS, ['question']);
          const q = questionOf(body);
          if (q.question === '') throw fail('question_empty', 'ask a question', { status: 400 });
          const answer = await engine.answer({ ...q, maxTokens: settings.maxTokens }, { signal: req.signal, actor: actorOf(req) });
          return { body: { answer } };
        },
      },
    ],
    start(ctx) {
      settings = moduleConfig('ask', ctx.config, { maxTokens: intIn(64, 32_000) }, settings);
      engine = createAnswerEngine({ hub, router: ctx.brains, audit: ctx.audit, auditKind: 'ask.answered', clock: ctx.clock, timeZone: ctx.timeZone, log: ctx.log });
    },
    stop() {
      engine = null;
    },
  };
}

/**
 * Module `chat`: conversations with history, streamed.
 * @param {{ hub: import('../setup/hub.js').Hub }} deps
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createChatModule({ hub }) {
  /** @type {import('./engine.js').AnswerEngine | null} */
  let engine = null;
  /** @type {import('./store.js').ChatStore | null} */
  let store = null;
  /** @type {any} */
  let ctx = null;
  let settings = { maxTokens: 1500, historyTurns: 6 };
  const live = () => {
    if (!engine || !store) throw fail('module_stopped', 'the chat is not running', { status: 503 });
    return { engine, store };
  };
  /** @param {string} id */
  const conversationOf = (id) => {
    const c = live().store.get(id);
    if (!c) throw notFound('conversation_unknown', 'conversation');
    return c;
  };

  return {
    id: 'chat',
    version: '1.0.0',
    title: 'Chat',
    namespaces: [CHATS_NAMESPACE],
    routes: [
      {
        method: 'POST',
        path: '/',
        access: 'member',
        maxBody: 64 * 1024,
        stream: true,
        handler(req) {
          const { engine: eng, store: st } = live();
          const body = bodyOf(req);
          checkBody(body, { ...QUESTION_FIELDS, conversation: text(64), tools: boolRule }, ['question']);
          const q = questionOf(body);
          if (q.question === '') throw fail('question_empty', 'ask a question', { status: 400 });
          const existing = typeof body.conversation === 'string' ? conversationOf(body.conversation) : null;
          const out = pushStream({ signal: req.signal, max: 5000 });
          const actor = actorOf(req);
          (async () => {
            let conversation = existing ?? st.create(q.question, q.dataClass);
            let answered = false;
            try {
              out.push('start', { conversation: conversation.id, turn: conversation.turns + 1 });
              const history = st.turns(conversation, settings.historyTurns).map((t) => ({ question: t.question, answer: t.answer.text }));
              const answer = await eng.answer(
                { ...q, dataClass: strictest(conversation.dataClass, q.dataClass), history, tools: body.tools === true, maxTokens: settings.maxTokens, subject: conversation.id },
                { signal: req.signal, emit: (event, data) => out.push(event, data), actor },
              );
              conversation = st.addTurn(conversation, q.question, answer);
              answered = true;
              out.push('done', { conversation: conversation.id, turn: conversation.turns, dataClass: conversation.dataClass, answer });
            } catch (err) {
              if (!req.signal.aborted) out.push('error', { code: codeOf(err) });
              else ctx?.log('info', 'turn_abandoned', { conversation: conversation.id });
            } finally {
              // A conversation that never got its first answer is not kept.
              if (!answered && conversation.turns === 0) st.remove(conversation);
              out.end();
            }
          })();
          return { stream: out.iterable };
        },
      },
      {
        method: 'GET',
        path: '/conversations',
        access: 'member',
        handler: () => ({ body: { conversations: live().store.list() } }),
      },
      {
        method: 'GET',
        path: '/conversations/:id',
        access: 'member',
        handler(req) {
          const c = conversationOf(req.params.id);
          return { body: { conversation: c, turns: live().store.turns(c) } };
        },
      },
      {
        method: 'PUT',
        path: '/conversations/:id',
        access: 'member',
        maxBody: 2048,
        handler(req) {
          const body = bodyOf(req);
          checkBody(body, { title: text(200) }, ['title']);
          const c = conversationOf(req.params.id);
          return { body: { conversation: live().store.rename(c, /** @type {string} */ (body.title)) } };
        },
      },
      {
        method: 'DELETE',
        path: '/conversations/:id',
        access: 'member',
        handler(req) {
          const c = conversationOf(req.params.id);
          live().store.remove(c);
          ctx.audit.append({ kind: 'chat.deleted', subject: c.id, actor: actorOf(req), details: { turns: c.turns } });
          return { body: { deleted: true, id: c.id } };
        },
      },
    ],
    start(context) {
      ctx = context;
      settings = moduleConfig('chat', ctx.config, { maxTokens: intIn(64, 32_000), historyTurns: intIn(0, 50) }, settings);
      store = createChatStore({ namespace: ctx.vault.namespace(CHATS_NAMESPACE), clock: ctx.clock });
      engine = createAnswerEngine({ hub, router: ctx.brains, audit: ctx.audit, auditKind: 'chat.answered', clock: ctx.clock, timeZone: ctx.timeZone, log: ctx.log });
    },
    stop() {
      engine = null;
      store = null;
    },
  };
}

