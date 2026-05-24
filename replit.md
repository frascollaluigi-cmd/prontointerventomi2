# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## App Tecnico (Expo, /app-tecnico/)
Mobile app for technicians to manage assigned jobs.
- **Auth**: telefono + 4-digit PIN → `/api/tecnico/login`. Token = `btoa("${id}:${pin}")` persisted in AsyncStorage via `contexts/AuthContext.tsx`.
- **Screens**: `app/index.tsx` (login), `app/richieste.tsx` (list with stats header + pull-to-refresh), `app/richiesta/[id].tsx` (detail with Accetta/Rifiuta/Completa, tel: link, Maps deeplink).
- **API helper**: `lib/api.ts` — uses `process.env.EXPO_PUBLIC_DOMAIN`.
- **Brand**: red gradient header (#1a202c → #c0392b), Inter font, lightning logo mark.
- **Known limits (per code review, deferred by user choice)**: PIN stored plaintext, token is reversible — acceptable for v1, harden later (JWT + bcrypt + rate-limit) before production launch.
- **Push Notifications**: On login (and on app startup if already logged in), the app requests permission and registers the Expo push token via `POST /api/tecnico/expo-token`. Token stored in `tecniciTable.expoToken`. Server sends push via `expo-server-sdk` when a request is assigned.

## Admin Panel (/admin)
Protected by HTTP Basic Auth (`admin` / `ADMIN_PASSWORD` env var, default: `prontoIntervento2026`).
- `/admin` — list all requests, assign technician to pending requests
- `/admin/tecnici` — add, edit (modal), toggle attivo/disattivo, delete technicians. PIN auto-generated on add and visible in the table.
