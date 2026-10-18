// On-device entailment for the second opinion (wasm/nli.js): nothing downloads without consent,
// the pinned catalog model is requested, stored files are checked before the worker reads them and
// new downloads before a result is used, and a failed check stops the worker. A stand-in worker
// answers like src/js/wasm/worker.js.
import './setup.mjs';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NLI_BATCH_SIZE, NLI_CATALOG, nliModelId } from '../../src/js/models/embed-catalog.js';
import { classifyPairs, NliConsentError, nli, nliEngine, nliModel, nliState, nliTarget, setNliRuntime, stopNli } from '../../src/js/wasm/nli.js';

/** A stand-in for the processor worker's NLI block. */
class FakeWorker extends EventTarget {
  /** @type {FakeWorker[]} */
  static made = [];
  /** @type {any[]} */
  messages = [];
  terminated = false;
  /** @type {(pair: { premise: string, hypothesis: string }) => { entailment: number, neutral: number, contradiction: number }} */
  static score = () => ({ entailment: 0.9, neutral: 0.05, contradiction: 0.05 });

  constructor() {
    super();
    FakeWorker.made.push(this);
  }

  /** @param {any} msg */
  postMessage(msg) {
    this.messages.push(msg);
    queueMicrotask(() => {
      const reply = (/** @type {any} */ data) => this.dispatchEvent(Object.assign(new Event('message'), { data }));
      for (const [file] of nliModel().files) reply({ id: msg.id, type: 'progress', file, loaded: 1, done: true });
      reply({ id: msg.id, type: 'classified', scores: msg.pairs.map(FakeWorker.score) });
    });
  }

  terminate() {
    this.terminated = true;
  }
}

/** @type {string[]} */
let checks = [];
/** @type {'full' | 'partial' | 'none'} */
let stored = 'none';
let failAfter = false;

beforeEach(() => {
  FakeWorker.made = [];
  checks = [];
  stored = 'none';
  failAfter = false;
  setNliRuntime({
    worker: () => /** @type {any} */ (new FakeWorker()),
    verify: async (target) => {
      checks.push(target.id);
      if (failAfter && checks.length > 1) throw Object.assign(new Error('1 downloaded file(s) do not match model-lock.json'), { name: 'IntegrityError' });
    },
    stored: async () => stored,
  });
});
afterEach(() => stopNli());

const PAIRS = [{ premise: 'The library opens at 9:00.', hypothesis: 'The library opens at nine.' }];

describe('on-device entailment', () => {
  it('downloads nothing without consent while the model is not stored', async () => {
    await assert.rejects(classifyPairs(PAIRS), NliConsentError);
    stored = 'partial';
    await assert.rejects(classifyPairs(PAIRS), NliConsentError);
    assert.equal(FakeWorker.made.length, 0, 'no worker started');
    assert.deepEqual(checks, [], 'no check ran');
  });

  it('with consent asks for the pinned model, checks before and after the download, and returns the probabilities', async () => {
    const scores = await classifyPairs(PAIRS, { consent: true });
    assert.deepEqual(scores, [{ entailment: 0.9, neutral: 0.05, contradiction: 0.05 }]);
    const [worker] = FakeWorker.made;
    const src = NLI_CATALOG['minilm-xnli'];
    assert.deepEqual(worker.messages[0], { id: 1, type: 'nli', source: { repo: src.repo, revision: src.revision, dtype: src.dtype }, pairs: PAIRS });
    assert.deepEqual(checks, [`nli:${src.repo}`, `nli:${src.repo}`]);
    assert.deepEqual(nliState(), { phase: 'ready', progress: 1, error: null });
    // Loaded once: later requests need no consent and are not checked again.
    await classifyPairs(PAIRS);
    assert.equal(checks.length, 2);
    assert.equal(FakeWorker.made.length, 1);
  });

  it('runs a stored model without asking again', async () => {
    stored = 'full';
    const result = await nli(PAIRS[0].premise, PAIRS[0].hypothesis);
    assert.equal(result.label, 'entailment');
  });

  it('splits long lists into batches the worker accepts', async () => {
    stored = 'full';
    const pairs = Array.from({ length: NLI_BATCH_SIZE * 2 + 1 }, (_, i) => ({ premise: `p${i}`, hypothesis: `h${i}` }));
    const progress = /** @type {number[]} */ ([]);
    const scores = await classifyPairs(pairs, { onProgress: (done) => progress.push(done) });
    assert.equal(scores.length, pairs.length);
    assert.deepEqual(FakeWorker.made[0].messages.map((m) => m.pairs.length), [NLI_BATCH_SIZE, NLI_BATCH_SIZE, 1]);
    assert.deepEqual(progress, [NLI_BATCH_SIZE, NLI_BATCH_SIZE * 2, NLI_BATCH_SIZE * 2 + 1]);
  });

  it('stops the worker and fails when a new download does not match the lock', async () => {
    failAfter = true;
    await assert.rejects(classifyPairs(PAIRS, { consent: true }), /model-lock\.json/);
    assert.equal(FakeWorker.made[0].terminated, true);
    assert.equal(nliState().phase, 'error');
  });

  it('is a second-opinion engine that maps probabilities to results and names the pinned model', async () => {
    stored = 'full';
    const engine = nliEngine();
    assert.equal(engine.id, 'nli');
    assert.equal(engine.model, nliModelId(nliModel()));
    assert.ok(engine.model.length <= 100, 'fits the receipt');
    const before = FakeWorker.score;
    FakeWorker.score = () => ({ entailment: 0.05, neutral: 0.1, contradiction: 0.85 });
    try {
      assert.deepEqual(await engine.classify(PAIRS), ['contradicted']);
    } finally {
      FakeWorker.score = before;
    }
  });

  it('checks exactly the pinned files of the model in the Transformers.js cache', () => {
    const src = nliModel();
    const target = nliTarget(src);
    const [scope] = target.scopes;
    assert.equal(target.runtime, 'nli');
    assert.equal(scope.match(`https://huggingface.co/${src.repo}/resolve/${src.revision}/${src.weights}`), `https://huggingface.co/${src.repo}/resolve/${src.revision}/${src.weights}`);
    assert.equal(scope.match(`https://huggingface.co/${src.repo}/resolve/main/config.json`), `https://huggingface.co/${src.repo}/resolve/${src.revision}/config.json`);
    assert.equal(scope.match('https://huggingface.co/other/model/resolve/main/config.json'), null);
    assert.equal(src.dtype, 'fp16');
    assert.ok(src.files.some(([file]) => file === src.weights));
  });
});
