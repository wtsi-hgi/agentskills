# Extension Development

How to build, test, and publish the Copilot Conductor VS Code extension.

## Prerequisites

- Node.js 18+
- VS Code 1.90+
- GitHub Copilot extension installed (for runtime LLM access)

## Setup

```bash
npm install
```

## Build

```bash
npm run build        # compile TypeScript to dist/
npm run typecheck    # type-check without emitting
```

The compiled output goes to `dist/` as CommonJS modules (target ES2022).

## Test

```bash
npm test             # run all tests with vitest
```

Tests are in `src/test/`, mirroring the `src/` structure. They use vitest with
mock implementations of VS Code APIs — no running VS Code instance is needed for
unit tests.

Key test areas:

| Test file | What it covers |
|---|---|
| `extension.test.ts` | Command handlers, activation, state persistence, crash recovery |
| `orchestrator/machine.test.ts` | State machine transitions, spec-writing pipeline, 2-consecutive-PASS gate, parallel batches |
| `orchestrator/parser.test.ts` | Phase file parsing |
| `llm/invoke.test.ts` | Tool-loop invocation, turn limits, cancellation |
| `llm/prompts.test.ts` | Prompt assembly, skill loading, conventions derivation |
| `llm/select.test.ts` | Model selection per role |
| `tools/bash.test.ts` | Bash execution, security validation, rejected patterns |
| `tools/dispatch.test.ts` | Tool dispatch (Read, Edit, Write, Grep, Glob) |
| `state/*.test.ts` | Persistence, audit log, addendum, transcript storage |
| `server/*.test.ts` | HTTP serving, WebSocket handlers, auth |
| `views/treeProvider.test.ts` | Sidebar tree rendering and status display |
| `webview/panel.test.ts` | Dashboard panel creation, message routing |

## Run Locally in VS Code

To test the extension inside a running VS Code instance:

1. Open this repository in VS Code.
2. Press `F5` (or **Run → Start Debugging**).
3. A new **Extension Development Host** window opens with the extension loaded.
4. In that window, open a project that has `.docs/conductor/spec.md` and phase
   files.
5. Run **Conductor: Start** from the Command Palette.

The Extension Development Host uses the TypeScript source via VS Code's built-in
extension debugging — no manual build step is needed for this workflow.

To iterate:

- Edit source files.
- Press `Ctrl+Shift+F5` (or **Run → Restart Debugging**) to reload.
- The extension host restarts with your changes.

## Package as VSIX

To create a distributable `.vsix` file:

```bash
npm install -g @vscode/vsce    # install once
npm run build                  # compile first
vsce package                   # creates copilot-conductor-x.y.z.vsix
```

The `.vsix` file can be shared directly or uploaded to a private extension
registry.

### What goes in the VSIX

The `vsce package` command bundles:

- `dist/` — compiled JavaScript
- `package.json` — extension manifest
- `media/` — icons
- `src/server/app/` — team server browser dashboard
- `docs/extension-guide.md` — user documentation

To exclude files, create a `.vscodeignore` file. A reasonable starting point:

```text
.docs/
.conductor/
.vscode/
src/**/*.ts
src/test/
skills/
docs/extension-development.md
docs/skills.md
tsconfig.json
vitest.config.*
node_modules/
.git/
.tmp/
```

## Publish

### Private sharing

Share the `.vsix` file directly. Recipients install via:

1. **Command Palette → Extensions: Install from VSIX…**
2. Select the file.

### VS Code Marketplace (public)

```bash
vsce login wtsi-hgi           # authenticate with a Personal Access Token
vsce publish                   # publish to marketplace
```

This requires a [Visual Studio Marketplace publisher
account](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
for the `wtsi-hgi` publisher ID.

### Internal registry

For organisation-internal distribution without the public marketplace, you can
host a [private extension
gallery](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#using-a-private-gallery)
or distribute via your artifact repository.

## Project Structure

```text
src/
  extension.ts             entry point (activate/deactivate)
  types.ts                 shared TypeScript interfaces
  tools/
    schema.ts              tool definitions (Read, Edit, Write, Bash, Grep, Glob)
    dispatch.ts            executes tool calls against the filesystem/shell
    bash.ts                Bash execution with security validation
  llm/
    select.ts              picks Copilot model per role from config
    prompts.ts             loads skills, assembles system prompts
    invoke.ts              tool-loop: send prompt → parse tool calls → dispatch → repeat
  skills/
    loader.ts              reads SKILL.md files from skillsDir
  orchestrator/
    parser.ts              parses phase markdown files into structured data
    machine.ts             state machine: spec-writing pipeline + implement → test → review, 2-PASS gate
  state/
    persistence.ts         reads/writes .conductor/state.json
    audit.ts               appends to .conductor/audit.md
    addendum.ts            appends to .conductor/addendum.md
    transcript.ts          writes per-invocation transcripts to .conductor/runs/
  views/
    treeProvider.ts        TreeView sidebar showing phases and item statuses
  webview/
    panel.ts               creates and manages the dashboard webview panel
    dashboard.html         dashboard UI (HTML + JS, dark theme)
  server/
    http.ts                HTTP server for team dashboard
    ws.ts                  WebSocket handler for real-time updates
    auth.ts                Bearer token authentication
    app/
      index.html           browser-based team dashboard SPA
  test/                    mirrors src/ — vitest unit tests
```

## Configuration Reference

All settings are under the `conductor.*` namespace. See
[extension-guide.md](extension-guide.md#configure) for the full table.
