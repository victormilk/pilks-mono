# pilks-mono

Monorepo for Pi Coding Agent (`@mariozechner/pi-coding-agent`) extensions.

## Packages

| Package | Description |
|---------|-------------|
| [`@victormilk/pi-vibeproxy`](./packages/pi-vibeproxy) | Pi extension that registers a CLIProxyAPIPlus instance as two model providers (Anthropic + OpenAI surfaces). |

## Development

Requires `pnpm` ≥ 9 and Node ≥ 20.

```bash
pnpm install
pnpm typecheck
```

Pi loads extensions as `.ts` directly via jiti — there is no build step.

## Installing an extension into Pi

From the workspace root:

```bash
pi install ./packages/pi-vibeproxy
```

Or for one-off testing:

```bash
pi -e ./packages/pi-vibeproxy/src/index.ts
```
