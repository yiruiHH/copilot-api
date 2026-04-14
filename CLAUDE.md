# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Summary

A reverse-engineered proxy for the GitHub Copilot API that exposes it as OpenAI-compatible (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and Anthropic-compatible (`/v1/messages`) endpoints. Allows using GitHub Copilot with any tool that supports these APIs, including Claude Code itself.

## Commands

- **Dev:** `bun run dev` (watch mode)
- **Build:** `bun run build` (uses tsdown)
- **Start:** `bun run start` (production)
- **Lint:** `bun run lint` (staged files) / `bun run lint:all` (all files)
- **Typecheck:** `bun run typecheck`
- **Test all:** `bun test`
- **Test single file:** `bun test tests/claude-request.test.ts`
- **Unused code detection:** `bun run knip`

## Architecture

### Entry Points

- `src/main.ts` - CLI entry using **citty** with subcommands: `start`, `auth`, `check-usage`, `debug`
- `src/server.ts` - **Hono** web framework router that mounts all route handlers

### Request Flow

1. CLI (`main.ts`) → `start.ts` bootstraps auth and server
2. Hono router (`server.ts`) dispatches to route handlers in `src/routes/`
3. Route handlers call services in `src/services/` (GitHub/Copilot API calls)
4. Responses are translated between OpenAI/Anthropic formats as needed

### Key Directories

- `src/routes/` - API endpoint handlers (`chat-completions/`, `messages/`, `models/`, `embeddings/`, `usage/`, `token/`)
- `src/services/` - External API calls (`github/` for auth, `copilot/` for completions/models)
- `src/lib/` - Shared utilities: global state (`state.ts`), token management (`token.ts`), API headers (`api-config.ts`), rate limiting, error handling, tokenizer
- `tests/` - Bun test runner tests (`*.test.ts`)
- `pages/` - Static web assets for the usage dashboard

### Anthropic-to-OpenAI Translation

The `src/routes/messages/` directory handles Anthropic Messages API compatibility by translating between Anthropic and OpenAI formats. Streaming (`stream-translation.ts`) and non-streaming (`non-stream-translation.ts`) responses have separate translation logic.

### Global State

`src/lib/state.ts` holds runtime state (tokens, config, models) as a mutable singleton. Route handlers and services read from this shared state.

## Code Style

- **Imports:** Use path alias `~/*` for `src/*` (e.g., `import { state } from "~/lib/state"`). ESM only, no CommonJS.
- **TypeScript:** Strict mode, no `any`, no unused locals/parameters, no switch fallthrough.
- **Naming:** camelCase for variables/functions, PascalCase for types/classes.
- **Validation:** Uses Zod v4 for runtime schema validation.
- **Git hooks:** Pre-commit runs lint-staged via simple-git-hooks.
