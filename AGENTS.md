# Working on Pi Pocket

In an npm install (inside `node_modules`), read only: to change Pi Pocket, clone the repository.

Pi Pocket is often edited from inside itself, while it runs. [docs/map.md](docs/map.md) says where things are, and [docs/architecture.md](docs/architecture.md) what they rely on. [docs/self-editing.md](docs/self-editing.md) has the whole of what follows, including how to check a change on a throwaway copy (`node test/serve.ts`); [docs/index.md](docs/index.md) lists every guide. Keep editing safe:

- `web/**` changes reload every open browser right away. Keep the app loadable after each save: a syntax error blanks the screen for everyone, including you. Check with `node --check web/<file>.js` after editing.
- `src/server/extensions/*.ts` changes are reinstalled into the running server. A file that fails to load keeps its previous version and reports the error. Each module default-exports `(host, web) => Extension | Extension[] | void`, possibly async (`web` adds routes and a browser module to the app: [docs/extensions/app.md](docs/extensions/app.md)). Start each module with a `/** … */` comment: its first sentence is the description in the app's Extensions sheet, where the owner can turn modules off (a module that is off is not loaded, even when edited).
- Other `src/server/**` changes need a restart (menu → Restart server). Running work resumes after it, but a tool call cut off mid-run that is not replay-safe comes back as interrupted. Do not restart while your own tool call is running; finish the edit, run `npm run check` and `npm test`, then ask the user to restart.
- The owner's drop-in extensions in `~/.pi-pocket/extensions/` load the same way, after the built-in ones, and stay off until the owner turns them on. A `node_modules` link there lets them import Pi Pocket's packages.
- Document kinds in `src/server/docs.ts` are stored data. Do not rename them, or change their scope, history, or fork settings: Pi Durable checks those against what is stored.
- Durable task checkpoints persist across restarts. When adding phases, bump the task version and migrate supported older checkpoints. Older definitions block newer stored versions.
- Webhook activity requires a fresh authenticated original root and protocol-1 token. Keep activity tokens, leases, and sequences in memory only. Never log the token, resume it after restart, or make final replies wait for activity.
- Reply-hook follow-ups require a fresh authenticated protocol-2 capability and exact stored submission origins. Never infer a recipient from the latest session answer, a requester ID, or task ownership alone. Reserve derived receipts before notification admission; defer at capacity rather than dropping delivery.
- Protocol-3 reply files require normal Guard approval of the actual export path and owner-only approval
  of each hash-pinned copy. Keep the 20 MiB/file and 4 files/40 MiB/message limits. Never infer files
  from Markdown or tool output. Legacy protocol-1/2 roots cannot acquire media authority.
- The SDK hands a logical run between conversation-owned generation tasks. At registration, record
  exact active input request IDs. Bind a manifest to the SDK submission's immutable answer and freeze
  its upload plan atomically. A generation ancestor is not terminal-answer authority.
- Inspect actual image containers before decode. Keep ordinary image processing serialized, with
  the 16-million-pixel cap and worker timeout. Worker threads share process RSS; V8 heap limits do not
  cap WebAssembly or native memory. Rejected images must remain usable file attachments. Validate
  the exact image bytes returned by Durable's `read` tool through the same bounded pipeline before
  they enter the transcript; never reopen a mutable path after inspection.
- The server is plain TypeScript run by Node's type stripping: only erasable syntax (no enums, no parameter properties, no namespaces). Imports use `.ts` extensions.
- Code style is Prettier (`.prettierrc.json`: 4 spaces, 100 columns) plus ESLint's layout rules (`eslint.config.js`): braces on every `if` and loop, and a blank line after declarations, around blocks, and before `return` and `throw`. Run `npm run format` after editing. Prettier leaves the markup in `html` templates alone, so lay it out by hand the same way: 4 spaces per level, and a tag that runs past 100 columns gets one attribute per line and its children on their own lines. In htm a line break is not a space: break only where there is no space, or between tags, never inside running text.
- Run `npm run check`, `npm run lint`, and `npm test` after server changes.
- The fork-only `.github/workflows/activity-validation.yml` tests `feat/issue-2-activity`. It gates the full suite and real Chromium tests on cheap checks. It never publishes or deploys.
