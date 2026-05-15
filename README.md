# pilks-mono

Monorepo for Pi Coding Agent (`@earendil-works/pi-coding-agent`) extensions.

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

From npm (once published):

```bash
pi install npm:@victormilk/pi-vibeproxy
```

From this monorepo (local checkout):

```bash
pi install ./packages/pi-vibeproxy
```

Or for one-off testing without installing:

```bash
pi -e ./packages/pi-vibeproxy/src/index.ts
```
