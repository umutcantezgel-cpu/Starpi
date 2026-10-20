// The class decision of the computer control: pure functions over what the actor reported.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  argumentsFit, decideClass, fold, hasControlCharacter, isFromTask, keyName, mentionsRiskyWord, namesOwnHost, saysNothing, strongest, windowProblem,
} from '../src/computer/classes.js';
import { ANY_LANGUAGE, BLOCKED_APPS_DEFAULT, LANGUAGES, RISKY_WORDS_DEFAULT, VAGUE_LABELS, buildPolicy, checkListOptions } from '../src/computer/lists.js';

const policy = buildPolicy({ openApps: ['org.example.calc'] }, { ownOrigins: ['https://app.example.org'] });
const editor = { app: 'org.example.editor', title: 'Draft', url: null };
const box = { x: 0, y: 0, w: 1000, h: 700 };

/** A report about a focused or pointed-at element in the example editor. */
function seen({ role = 'textbox', label = 'Body', front = editor, win = { ...editor, box }, dialog = null } = {}) {
  return { front, window: win, element: role === null ? null : { role, label }, dialog, screen: { width: 1000, height: 700 } };
}
const ctx = (task = 'Write Dear team in the draft', screenRead = false) => ({ task, screenRead });
const step = (action, args, why = 'move the work along') => ({ action, args, why });

test('normalising helpers: fold, strongest, keys, control characters', () => {
  assert.equal(fold('  Don’t   SAVE '), "don't save");
  assert.equal(strongest('read', 'low'), 'low');
  assert.equal(strongest('low', 'nonsense'), 'forbidden');
  assert.equal(keyName('Return'), 'enter');
  assert.equal(keyName('Cmd+Z'), 'mod+z');
  assert.equal(keyName('ctrl+c'), 'mod+c');
  assert.equal(keyName('⌘V'), 'mod+v');
  assert.equal(keyName('ArrowDown'), 'down');
  assert.equal(keyName('Page Down'), 'pagedown');
  assert.equal(keyName('shift+tab'), 'shift+tab');
  assert.equal(keyName('hyper+x'), null);
  assert.equal(keyName('F13'), null);
  assert.equal(hasControlCharacter('two\nlines'), false);
  assert.equal(hasControlCharacter('tab\there'), true);
  assert.equal(hasControlCharacter('cr\rhere'), true);
  assert.equal(hasControlCharacter('sep here'), true);
});

test('text counts as from the task only as whole words', () => {
  const task = 'Reply with Thanks, see you on 3 May';
  assert.equal(isFromTask('Thanks', task), true);
  assert.equal(isFromTask('see you on 3 May', task), true);
  assert.equal(isFromTask('Than', task), false, 'a piece of a word');
  assert.equal(isFromTask('h', task), false, 'a single letter inside a word');
  assert.equal(isFromTask(', see', task), true, 'punctuation at the edge needs no boundary');
  assert.equal(isFromTask('thanks', task), false, 'case matters');
  assert.equal(isFromTask('', task), false);
});

test('risky words and own hosts', () => {
  assert.equal(mentionsRiskyWord('Delete all', RISKY_WORDS_DEFAULT), true);
  assert.equal(mentionsRiskyWord('Sending...', RISKY_WORDS_DEFAULT), true);
  assert.equal(mentionsRiskyWord('Undelete', RISKY_WORDS_DEFAULT), false, 'only at the start of a word');
  assert.equal(mentionsRiskyWord('Do not save', RISKY_WORDS_DEFAULT), true);
  assert.equal(mentionsRiskyWord('Open', RISKY_WORDS_DEFAULT), false);
  assert.equal(mentionsRiskyWord('Postpone', RISKY_WORDS_DEFAULT), false, 'a whole word unless the entry is a stem');
  assert.equal(namesOwnHost('go to http://localhost:47821', policy), true);
  assert.equal(namesOwnHost('127.0.0.1', policy), true);
  assert.equal(namesOwnHost('see app.example.org/settings', policy), true);
  assert.equal(namesOwnHost('see docs.example.net', policy), false);
});

/** Consequential controls as an interface in each shipped language labels them. */
const RISKY_LABELS = {
  en: ['Send', 'Delete', 'Pay now', 'Buy', 'Confirm', 'Submit', 'Publish', 'Remove', 'Transfer', 'Add payee', 'Request payout', 'PayPal', 'Become a buyer', 'Get a shareable link'],
  de: ['Senden', 'Löschen', 'Jetzt bezahlen', 'Kaufen', 'Bestätigen', 'Absenden', 'Veröffentlichen', 'Entfernen', 'Überweisen', 'Zahlungspflichtig bestellen', 'Übermitteln'],
  fr: ['Envoyer', 'Supprimer', 'Payer', 'Acheter', 'Confirmer', 'Soumettre', 'Publier', 'Retirer', 'Transférer', 'Valider', 'Payez', 'Achetez', 'Commandez', 'Abonnez-vous'],
  es: ['Enviar', 'Eliminar', 'Pagar', 'Comprar', 'Confirmar', 'Publicar', 'Quitar', 'Transferir', 'Cerrar sesión'],
  it: ['Invia', 'Elimina', 'Paga ora', 'Acquista', 'Conferma', 'Pubblica', 'Rimuovi', 'Trasferisci', 'Non salvare', 'Iscriviti'],
  tr: ['Gönder', 'Sil', 'Öde', 'Satın al', 'Onayla', 'Yayınla', 'Kaldır', 'Havale yap', 'Çıkış yap'],
};
/** Harmless words that merely begin like a risky one: whole-word matching leaves them alone. */
const HARMLESS_LABELS = {
  en: ['Postpone', 'Payload', 'Undelete', 'Silver'],
  de: ['Posteingang', 'Ordner', 'Abbrechen', 'Speichern'],
  fr: ['Publicité', 'Annuler', 'Enregistrer'],
  es: ['Página', 'Cancelar', 'Guardar'],
  it: ['Pagina', 'Annulla', 'Salva'],
  tr: ['Silgi', 'Ödev', 'İletişim', 'İptal', 'Kaydet'],
};

test('risky words of every shipped language raise the class, in any case and as whole words', () => {
  assert.deepEqual(Object.keys(RISKY_WORDS_DEFAULT), [...LANGUAGES]);
  assert.deepEqual(Object.keys(RISKY_LABELS), [...LANGUAGES]);
  for (const lang of LANGUAGES) {
    for (const label of RISKY_LABELS[lang]) {
      for (const shown of [label, label.toLocaleUpperCase(lang), label.toLocaleLowerCase(lang)]) {
        assert.equal(mentionsRiskyWord(shown, policy.riskyWords), true, `${lang}: ${shown}`);
        assert.equal(mentionsRiskyWord(shown, { [lang]: RISKY_WORDS_DEFAULT[lang] }), true, `${lang} list alone: ${shown}`);
      }
      const ruling = decideClass(step('pointer.click', { at: [5, 5] }), seen({ role: 'button', label }), policy, ctx());
      assert.equal(ruling.cls, 'high', `${lang}: a click on ${label}`);
      assert.ok(ruling.reasons.includes('risky_target'), `${lang}: ${label} ${ruling.reasons}`);
      const said = decideClass(step('pointer.click', { at: [5, 5] }, `${label} the draft`), seen({ role: 'button', label: 'Bold' }), policy, ctx());
      assert.deepEqual(said.reasons, ['risky_purpose'], `${lang}: the purpose ${label}`);
    }
    for (const label of HARMLESS_LABELS[lang]) assert.equal(mentionsRiskyWord(label, policy.riskyWords), false, `${lang}: ${label}`);
  }
});

test('each language is compared under its own case rules; accents may be left out', () => {
  // Turkish: the capital of i is İ and the capital of ı is I.
  assert.equal(mentionsRiskyWord('KALDIR', { tr: ['kaldır'] }), true);
  assert.equal(mentionsRiskyWord('KALDIR', { en: ['kaldır'] }), false, 'under the root rules KALDIR folds to kaldir');
  assert.equal(mentionsRiskyWord('SİL', { tr: ['sil'] }), true);
  assert.equal(mentionsRiskyWord('SIL', { tr: ['sil'] }), true, 'an interface may drop the dot of the capital');
  assert.equal(mentionsRiskyWord('ONAYLIYORUM', RISKY_WORDS_DEFAULT), true, 'a stem');
  assert.equal(mentionsRiskyWord('İLET', RISKY_WORDS_DEFAULT), true);
  assert.equal(mentionsRiskyWord('Silent mode', RISKY_WORDS_DEFAULT), false, 'sil is a whole word');
  assert.equal(fold('İLET', 'tr'), 'ilet');
  assert.equal(fold('KALDIR', 'tr'), 'kaldır');
  // Capitals often go without their accents.
  assert.equal(mentionsRiskyWord('DESINSTALLER', RISKY_WORDS_DEFAULT), true);
  assert.equal(mentionsRiskyWord('ENVIO GRATIS', RISKY_WORDS_DEFAULT), true);
  assert.equal(mentionsRiskyWord('CIKIS YAP', RISKY_WORDS_DEFAULT), true);
});

test('vague labels of every shipped language raise a click', () => {
  const vague = { en: 'Continue', de: 'Weiter', fr: 'Continuer', es: 'Siguiente', it: 'Avanti', tr: 'İleri' };
  assert.deepEqual(Object.keys(VAGUE_LABELS), [...LANGUAGES]);
  for (const lang of LANGUAGES) {
    for (const label of [vague[lang], vague[lang].toLocaleUpperCase(lang)]) {
      assert.equal(saysNothing(label), true, `${lang}: ${label}`);
      const ruling = decideClass(step('pointer.click', { at: [5, 5] }), seen({ role: 'button', label }), policy, ctx());
      assert.deepEqual(ruling.reasons, ['target_vague'], `${lang}: ${label}`);
    }
  }
  assert.equal(saysNothing('ILERI'), true);
  assert.equal(saysNothing(''), true);
  assert.equal(saysNothing('Weiterleitung einrichten'), false, 'only a whole label is vague');
  assert.equal(saysNothing('Bold'), false);
});

test('windows: blocked, own, unverified browser, allow list', () => {
  assert.equal(windowProblem({ app: null }, policy), 'app_unknown');
  assert.equal(windowProblem({ app: '../etc' }, policy), 'app_unknown');
  assert.equal(windowProblem({ app: 'com.apple.Terminal' }, policy), 'app_blocked');
  assert.equal(windowProblem({ app: 'com.apple.Safari', url: null }, policy), 'window_unverified');
  assert.equal(windowProblem({ app: 'com.apple.Safari', url: 'http://127.0.0.1:47821/' }, policy), 'own_window');
  assert.equal(windowProblem({ app: 'com.apple.Safari', url: 'https://app.example.org/chat' }, policy), 'own_window');
  assert.equal(windowProblem({ app: 'com.google.Chrome.app.abcdef', url: 'http://[::1]:5000/' }, policy), 'own_window');
  assert.equal(windowProblem({ app: 'com.apple.Safari', url: 'https://news.example.net/' }, policy), null);
  const narrow = buildPolicy({ allowApps: ['org.example.editor'] });
  assert.equal(windowProblem({ app: 'org.example.editor' }, narrow), null);
  assert.equal(windowProblem({ app: 'org.example.other' }, narrow), 'app_not_listed');
});

test('arguments must have exactly the members of their action', () => {
  assert.equal(argumentsFit('screen.look', {}), true);
  assert.equal(argumentsFit('screen.look', { at: [1, 1] }), false);
  assert.equal(argumentsFit('pointer.click', { at: [10, 20] }), true);
  assert.equal(argumentsFit('pointer.click', { at: [10.5, 20] }), false);
  assert.equal(argumentsFit('pointer.scroll', { at: [1, 1], direction: 'down', lines: 3 }), true);
  assert.equal(argumentsFit('pointer.scroll', { at: [1, 1], direction: 'down', lines: 41 }), false);
  assert.equal(argumentsFit('keyboard.press', { key: 'enter', times: 2 }), true);
  assert.equal(argumentsFit('keyboard.press', { key: 'enter', times: 11 }), false);
  assert.equal(argumentsFit('keyboard.type', { text: 'x'.repeat(1001) }), false);
  assert.equal(argumentsFit('app.open', { app: 'org.example.calc' }), true);
  assert.equal(argumentsFit('app.open', { app: '/Applications/X.app' }), false);
});

test('read and low steps: looking, scrolling, typing task text into a plain field, a named button', () => {
  assert.deepEqual(decideClass(step('screen.look', {}), seen(), policy, ctx()).cls, 'read');
  assert.equal(decideClass(step('pointer.scroll', { at: [10, 10], direction: 'down', lines: 3 }), seen(), policy, ctx()).cls, 'low');
  const typed = decideClass(step('keyboard.type', { text: 'Dear team' }), seen(), policy, ctx());
  assert.equal(typed.cls, 'low');
  assert.deepEqual(typed.target, { app: 'org.example.editor', title: 'Draft', role: 'textbox', label: 'Body' });
  assert.equal(decideClass(step('pointer.click', { at: [10, 10] }), seen({ role: 'button', label: 'Bold' }), policy, ctx()).cls, 'low');
  assert.equal(decideClass(step('keyboard.press', { key: 'tab' }), seen(), policy, ctx()).cls, 'low');
  assert.equal(decideClass(step('app.open', { app: 'org.example.calc' }), {}, policy, ctx()).cls, 'low');
});

test('high steps: what raises the class and why', () => {
  const reasons = (s, r, c = ctx()) => {
    const out = decideClass(s, r, policy, c);
    assert.equal(out.cls, 'high');
    return out.reasons;
  };
  assert.deepEqual(reasons(step('keyboard.type', { text: 'Dear all' }), seen()), ['text_not_from_task']);
  assert.ok(reasons(step('pointer.click', { at: [5, 5] }), seen({ role: 'button', label: 'Delete draft' })).includes('risky_target'));
  assert.ok(reasons(step('pointer.click', { at: [5, 5] }), seen({ role: 'button', label: 'Keep', dialog: 'Discard all changes?' })).includes('risky_target'));
  assert.ok(reasons(step('pointer.click', { at: [5, 5] }, 'send the reply'), seen({ role: 'button', label: 'Arrow' })).includes('risky_purpose'));
  assert.ok(reasons(step('pointer.click', { at: [5, 5] }), seen({ role: 'button', label: 'OK' })).includes('target_vague'));
  assert.ok(reasons(step('pointer.click', { at: [5, 5] }), seen({ role: null })).includes('target_unknown'));
  assert.deepEqual(reasons(step('keyboard.press', { key: 'cmd+v' }), seen()), ['key_needs_approval']);
  const mail = { app: 'com.apple.mail', title: 'Inbox', url: null };
  const inMail = seen({ role: 'button', label: 'Archive', front: mail, win: { ...mail, box } });
  assert.ok(reasons(step('pointer.click', { at: [5, 5] }), inMail).includes('careful_app'));
  assert.ok(reasons(step('keyboard.press', { key: 'enter' }), seen({ front: mail, win: { ...mail, box } })).includes('enter_in_careful_app'));
  assert.deepEqual(reasons(step('app.open', { app: 'org.example.calc' }), {}, ctx('x', true)), ['opened_after_screen_read']);
  // The stated purpose only ever raises: a harmless purpose does not lower a risky target.
  assert.ok(reasons(step('pointer.click', { at: [5, 5] }, 'just tidy up'), seen({ role: 'button', label: 'Remove' })).includes('risky_target'));
});

test('forbidden steps: unknown, malformed, blocked, secret or unknown fields, keys off the list, own window', () => {
  const why = (s, r, c = ctx()) => {
    const out = decideClass(s, r, policy, c);
    assert.equal(out.cls, 'forbidden');
    return out.reasons[0];
  };
  assert.equal(why(step('shell.run', { cmd: 'ls' }), seen()), 'unknown_action');
  assert.equal(why(step('pointer.click', { at: 'middle' }), seen()), 'bad_arguments');
  assert.equal(why(step('pointer.click', { at: [5, 5] }, ''), seen()), 'purpose_missing');
  assert.equal(why(step('pointer.click', { at: [5, 5] }), seen({ win: null })), 'app_unknown', 'a click never assumes the frontmost window');
  assert.equal(why(step('pointer.click', { at: [5, 900] }), seen()), 'off_screen');
  assert.equal(why(step('pointer.click', { at: [5, 5] }), seen({ win: { ...editor, box: { x: 100, y: 100, w: 50, h: 50 } } })), 'off_window');
  const term = { app: 'com.apple.Terminal', title: 'zsh', url: null };
  assert.equal(why(step('screen.look', {}), seen({ front: term })), 'app_blocked');
  assert.equal(why(step('keyboard.type', { text: 'Dear team' }), seen({ role: 'password', label: 'Password' })), 'field_secret');
  assert.equal(why(step('keyboard.type', { text: 'Dear team' }), seen({ role: 'button', label: 'Send' })), 'field_unknown');
  assert.equal(why(step('keyboard.type', { text: 'Dear team' }), seen({ role: null })), 'field_unknown');
  assert.equal(why(step('keyboard.type', { text: 'Dear\tteam' }), seen()), 'control_character');
  assert.equal(why(step('keyboard.type', { text: 'localhost:47821' }, 'go'), seen(), ctx('open localhost:47821')), 'own_address');
  assert.equal(why(step('keyboard.press', { key: 'cmd+q' }), seen()), 'key_not_listed');
  assert.equal(why(step('keyboard.press', { key: 'alt+f4' }), seen()), 'key_not_listed');
  const own = { app: 'com.apple.Safari', title: 'Starpi', url: 'https://app.example.org/' };
  assert.equal(why(step('pointer.click', { at: [5, 5] }), seen({ role: 'button', label: 'Approve', front: own, win: { ...own, box } })), 'own_window');
  assert.equal(why(step('app.open', { app: 'com.apple.Terminal' }), {}), 'app_blocked');
  assert.equal(why(step('app.open', { app: 'org.example.other' }), {}), 'app_not_listed');
});

test('configured lists: the block list only grows, keys only shrink, blocked apps cannot be allowed', () => {
  assert.deepEqual(checkListOptions({ openApps: ['com.apple.Terminal'] }), ['modules.computer.openApps: com.apple.Terminal is blocked']);
  assert.deepEqual(checkListOptions({ keys: ['enter', 'mod+q'] }), ['modules.computer.keys: only keys of the allow list (mod+q is not)']);
  assert.deepEqual(checkListOptions({ blockApps: ['org.example.editor'], riskyWords: ['archive', 'move to', 'archiv*'] }), []);
  for (const bad of [['ar*chive'], ['a*'], ['*'], [' x ']]) assert.equal(checkListOptions({ riskyWords: bad }).length, 1, JSON.stringify(bad));
  const tight = buildPolicy({ blockApps: ['org.example.editor'], keys: ['tab'], riskyWords: ['Archive', 'ARŞİVLE'] });
  for (const id of BLOCKED_APPS_DEFAULT) assert.ok(tight.blocked.has(id));
  assert.ok(tight.blocked.has('org.example.editor'));
  assert.deepEqual([...tight.keys.keys()], ['tab']);
  assert.deepEqual(tight.riskyWords[ANY_LANGUAGE], ['Archive', 'ARŞİVLE']);
  for (const lang of LANGUAGES) assert.deepEqual(tight.riskyWords[lang], RISKY_WORDS_DEFAULT[lang], `the ${lang} defaults stay`);
  assert.equal(mentionsRiskyWord('archive', tight.riskyWords), true);
  assert.equal(mentionsRiskyWord('Archived', tight.riskyWords), false, 'a configured word matches whole words');
  assert.equal(mentionsRiskyWord('Archived', buildPolicy({ riskyWords: ['archiv*'] }).riskyWords), true, 'a trailing * makes a stem');
  assert.equal(mentionsRiskyWord('Arşivle', tight.riskyWords), true, 'configured words follow every language\'s case rules');
  assert.equal(tight.openable.size, 0);
  assert.equal(decideClass(step('keyboard.press', { key: 'enter' }), seen({ front: { app: 'org.example.notes' }, win: { app: 'org.example.notes', box } }), tight, ctx()).reasons[0], 'key_not_listed');
});
