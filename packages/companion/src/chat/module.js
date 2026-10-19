// @ts-check
// Modules `ask` and `chat`: questions to the companion, answered by the engine (engine.js) and
// always through the sentence gate of @starpi/core.
//   POST   /v1/ask                           member  { question, mode?, dataClass?, documents?, notes?, feeds? }
//                                                    -> { answer } in one JSON answer
//   POST   /v1/chat                          member  { question, conversation?, after?, mode?, dataClass?,
//                                                    documents?, notes?, feeds?, tools? } -> server-sent events:
//          start {conversation, turn, from?}, sources {...}, unit {text, cites, kind} (as units are released),
//          reset {withdrawn}, tool {tool, state}, approval {...}, done {conversation, turn, answer},
//          error {code}; the kernel ends every stream with `audit` (the signed head)
//   GET    /v1/chat/conversations            member  the conversations, most recent first
//   GET    /v1/chat/conversations/:id        member  one conversation with its turns
//   PUT    /v1/chat/conversations/:id        member  { title } renames it
//   DELETE /v1/chat/conversations/:id        member  deletes it with every turn
// The turns of one conversation run one after the other: a turn sent while another one runs waits
// for it (its `start` comes when it begins, and its history holds the turn before it); a turn
// beyond `waitingTurns` waiting ones is refused with 409 conversation_busy.
// `after` (with `conversation`) is the number of turns the question follows. A client that keeps
// its history as a tree sends it with every turn: when the conversation already has more turns (the
// client asked a question again, changed one, or went back to another branch), the turns up to
// `after` are copied into a new conversation and the question goes on there; `start` and `done`
// then name the new conversation and `start` names the one it came `from`. A copy whose first own
// turn is not answered is not kept.
// `mode` is `sources` (default: answer from the companion's documents, notes and feed readings,
// every number checked against the source a sentence cites) or `free` (general knowledge; the gate
// still withholds links and characters outside its allowlist). `dataClass` defaults to personal.
// Tools of connectors are offered only in the chat and only when `tools` is true.
// Configuration (`modules.ask`, `modules.chat`): { "maxTokens": 1500, "historyTurns": 6, "waitingTurns": 4 }
// (history and waiting turns: chat only).
import { text } from '../contracts/check.js';
import { DATA_CLASSES, isDataClass, strictest } from '../contracts/data-classes.js';
import { codeOf, fail } from '../lib/errors.js';
import { actorOf, bodyOf, checkBody, intIn, moduleConfig, notFound, pushStream } from '../setup/kit.js';
import { createAnswerEngine, MODES } from './engine.js';
import { CHATS_NAMESPACE, createChatStore, MAX_TURNS } from './store.js';

export const MAX_QUESTION_CHARS = 8000;

/** @param {unknown} v */
const modeRule = (v) => (MODES.includes(/** @type {any} */ (v)) ? null : `one of ${MODES.join(', ')}`);
/** @param {unknown} v */
const classRule = (v) => (isDataClass(v) ? null : `one of ${DATA_CLASSES.join(', ')}`);
/** @param {unknown} v */
const boolRule = (v) => (typeof v === 'boolean' ? null : 'true or false');
/** @param {unknown} v */
const afterRule = (v) => (Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) <= MAX_TURNS ? null : `a whole number from 0 to ${MAX_TURNS}`);
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
  let settings = { maxTokens: 1500, historyTurns: 6, waitingTurns: 4 };
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
  /** @type {Map<string, { tail: Promise<void>, size: number }>} conversation id -> its turns, running and waiting */
  const lanes = new Map();
  /**
   * A place in the conversation's lane: `ready` settles when every turn before it has ended, and
   * `leave` ends this one (also when it gave up while waiting; the next still waits for the rest).
   * `wait(signal)` waits for `ready` and gives the place back at once when the client goes away
   * first, so a turn nobody listens to any more does not count against `waitingTurns`.
   * @param {string} id
   */
  const enterLane = (id) => {
    const lane = lanes.get(id) ?? { tail: Promise.resolve(), size: 0 };
    if (lane.size > settings.waitingTurns) throw fail('conversation_busy', 'too many turns of this conversation are waiting', { status: 409 });
    lanes.set(id, lane);
    lane.size += 1;
    /** @type {() => void} */
    let end = () => {};
    const ended = new Promise((resolve) => (end = () => resolve(undefined)));
    const ready = lane.tail;
    lane.tail = ready.then(() => ended);
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      end();
      lane.size -= 1;
      if (lane.size === 0 && lanes.get(id) === lane) lanes.delete(id);
    };
    return {
      ready,
      leave,
      /** @param {AbortSignal} signal */
      wait(signal) {
        return new Promise((resolve, reject) => {
          const gone = () => {
            leave();
            reject(signal.reason ?? new Error('aborted'));
          };
          if (signal.aborted) {
            gone();
            return;
          }
          signal.addEventListener('abort', gone, { once: true });
          ready.then(() => {
            signal.removeEventListener('abort', gone);
            resolve(undefined);
          });
        });
      },
    };
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
          checkBody(body, { ...QUESTION_FIELDS, conversation: text(64), after: afterRule, tools: boolRule }, ['question']);
          const q = questionOf(body);
          if (q.question === '') throw fail('question_empty', 'ask a question', { status: 400 });
          if (body.after !== undefined && typeof body.conversation !== 'string') throw fail('body_invalid', '`after` needs the conversation it counts in', { status: 400 });
          const after = /** @type {number | undefined} */ (body.after);
          const existing = typeof body.conversation === 'string' ? conversationOf(body.conversation) : null;
          const created = existing ? null : st.create(q.question, q.dataClass);
          let conversation = /** @type {import('./store.js').Conversation} */ (existing ?? created);
          // The lane of a new conversation is empty, so only a turn of a known one can be refused here.
          const lane = enterLane(conversation.id);
          const out = pushStream({ signal: req.signal, max: 5000 });
          const actor = actorOf(req);
          (async () => {
            let answered = false;
            /** @type {import('./store.js').Conversation | null} */
            let branched = null;
            /** @type {ReturnType<typeof enterLane> | null} */
            let branchLane = null;
            try {
              await lane.wait(req.signal);
              // The turns before this one changed the conversation, or deleted it.
              const current = st.get(conversation.id);
              if (!current) throw notFound('conversation_unknown', 'conversation');
              conversation = current;
              // The question follows an earlier turn than the last one: it goes on in a copy of the
              // turns up to that one. The copy has a lane of its own from the start, so a turn sent
              // to it once `start` named it waits for this one.
              if (after !== undefined && after < current.turns) {
                branched = st.branch(current, after);
                branchLane = enterLane(branched.id);
                conversation = branched;
              }
              out.push('start', { conversation: conversation.id, turn: conversation.turns + 1, ...(branched ? { from: current.id } : {}) });
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
              // A conversation that never got its first answer is not kept, nor a copy that never
              // got its own.
              if (!answered && created && st.get(created.id)?.turns === 0) st.remove(created);
              if (!answered && branched && st.get(branched.id)?.turns === branched.turns) st.remove(branched);
              branchLane?.leave();
              lane.leave();
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
      settings = moduleConfig('chat', ctx.config, { maxTokens: intIn(64, 32_000), historyTurns: intIn(0, 50), waitingTurns: intIn(0, 16) }, settings);
      store = createChatStore({ namespace: ctx.vault.namespace(CHATS_NAMESPACE), clock: ctx.clock });
      engine = createAnswerEngine({ hub, router: ctx.brains, audit: ctx.audit, auditKind: 'chat.answered', clock: ctx.clock, timeZone: ctx.timeZone, log: ctx.log });
    },
    stop() {
      engine = null;
      store = null;
    },
  };
}

