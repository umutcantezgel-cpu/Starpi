# Computer control (experimental, off by default)

A companion module that lets a language model operate the computer in small, recorded steps
while the person watches. In this release it drives a **simulated screen only** (the mock actor).
The macOS actor is a **preview, not verified on hardware**: it cannot be constructed, and the
setting `"actor": "macos"` is refused when the module starts.

## Switching it on

Nothing of this module exists unless the configuration says so:

```json
{
  "experimental": { "computer": true },
  "modules": {
    "computer": {
      "mandateSeconds": 120,
      "approvalSeconds": 60,
      "maxTurns": 30,
      "brain": "local",
      "blockApps": [],
      "allowApps": [],
      "openApps": [],
      "carefulApps": [],
      "browsers": [],
      "ownApps": [],
      "keys": ["enter", "tab", "escape"],
      "riskyWords": ["archive", "move to"]
    }
  }
}
```

Every member of `modules.computer` is optional. Durations can only be shortened (a mandate lasts
30 to 120 seconds, an approval request 10 to 60 seconds). The block list, the careful list, the
browsers, the own apps and the risky words only grow; the key allow list only shrinks; an allow
list of apps, when set, narrows everything further. `openApps` lists the apps `app.open` may start;
without it the action is not offered. Blocked apps can be neither allowed nor opened.

## How a run goes

1. **Consent.** An `owner` session grants it for the current version of the consent statement.
   It is recorded with the SHA-256 of the statement and survives restarts. Withdrawing works at
   any time and ends the running mandate at once.
2. **Mandate.** An `owner` session starts one with a task and, optionally, a narrower list of
   actions. It lasts at most 120 seconds and is never extended on its own: only the session that
   started it (the mandate owner) extends it, which sets the deadline to the full length from now.
   With 15 seconds or less left, no further step starts until it is extended or ends.
3. **Agent loop.** The loop asks a model through the kernel's brain router for one to six steps as
   a small JSON object, hands each step to the controller and reports the results back. Screen
   content is sent as data class `sensitive` (local models only) unless the mandate owner marks the
   mandate `shareable`. Without a model the router's template answer ends the mandate.
4. **Classes.** Every step is classed just before it runs, from what the actor reports about the
   target, never from what the model claims:
   - `read`: looking at the screen;
   - `low`: local input the task asks for, such as a click on a named control or text taken
     literally from the task;
   - `high`: runs only after the mandate owner approved this one step (risky words on the control
     or in the stated purpose, careful apps such as mail or the browser, vague or unknown controls,
     text not taken from the task, keys such as paste and save, opening an app after the screen was
     read);
   - `forbidden`: never runs (blocked apps, the window showing Starpi or the companion, browser
     windows whose address is unknown, secret or unknown fields, keys off the allow list, control
     characters in typed text, points outside the screen or the window).
5. **Approvals.** Only the mandate owner decides. Nobody can decide, extend, grant consent or start
   a mandate while the actor works or for two seconds after its last step (`actor_busy`, 409), so
   the actor can never press the button that lets it go on. An approved step is looked at again
   right before it runs; a different target voids the approval.
6. **Stop.** Any paired session, never refused, no model involved. It aborts the model request and
   the step in progress, waits at most a second for the standstill and records how long it took.
   Every stop request is recorded (`computer.stop.requested`) with what it met: `idle`, `running`,
   or `ending` when an expiry, a withdrawal or the end of the task was already ending the mandate.
   The stop flag is kept until the owner starts the next mandate, also across restarts. A restart
   ends a mandate that was running.

Every decision and every step is a record in the audit chain (`computer.*`: ids, codes, counts and
app ids; never the task, typed text, window titles or screen content). A typing step records how
many characters were actually typed, also when it stopped part-way. The task, approval previews,
the journal and model text live in memory only.

## Routes

| Route | Access | Body / answer |
| --- | --- | --- |
| `GET /v1/computer` | member | consent, stop flag, the running mandate, the open approval (its preview only for the mandate owner); hints and model summaries only for owner sessions and the session that started their mandate (other members get an empty `notes` list) |
| `POST /v1/computer/consent` | owner | `{ grant: true, version }` or `{ grant: false }` |
| `POST /v1/computer/mandate` | owner | `{ task, shareable?, actions? }` |
| `POST /v1/computer/mandate/extend` | member (mandate owner only) | `{ mandate }` |
| `POST /v1/computer/stop` | member | `{}`; never refused |
| `POST /v1/computer/approvals/:id` | member (mandate owner only) | `{ decision: "allow" \| "deny" }` |
| `GET /v1/computer/journal` | owner | the steps and notes since the companion started |

Error codes: `consent_missing`, `consent_version`, `consent_invalid`, `mandate_running`,
`mandate_invalid`, `mandate_not_running`, `not_mandate_owner`, `actor_busy`,
`approval_not_found`, `approval_expired`, `decision_invalid`, `computer_not_ready`.

## Limits of this release

- No real screen: only the mock actor runs. The companion forbids starting processes, which a
  desktop actor would need.
- No shell tools for models; no image of the screen, only its structure and visible text.
- One mandate at a time, one installation owner.
