# Architecture Standard

## Backend: Hybrid 4-Layer + Vertical-Slice Features

The backend is split into two zones: **platform** (cross-cutting infrastructure) and **features** (vertical slices, one per user-facing capability). Within each feature the 4-layer separation still applies.

```
server/src/
├── db/                        # PLATFORM: persistence
│   ├── client.ts              # Drizzle client + pool
│   ├── schema.ts              # all tables in one file (single source for migrations)
│   ├── relations.ts           # cross-feature foreign keys
│   └── seeds/                 # one file per entity
│       ├── books.seed.ts
│       └── system-prompts.seed.ts
│
├── middleware/                # PLATFORM: auth, validation, error, logging
│   ├── validate.ts            # Zod-validating request middleware
│   ├── error-handler.ts       # express error middleware
│   └── logger.ts
│
├── routes/                    # PLATFORM: route registration aggregator
│   └── index.ts               # imports all features/*/*.routes.ts
│
├── lib/                       # PLATFORM: shared utilities (no business logic)
│   ├── result.ts              # ServiceResult<T> type + helpers
│   └── error-codes.ts
│
└── features/                  # VERTICAL SLICES — one folder per user-facing capability
    ├── books/
    │   ├── books.routes.ts        # Express router for /api/books
    │   ├── books.controller.ts    # HTTP in/out
    │   ├── books.service.ts       # business logic; returns ServiceResult<T>
    │   ├── books.zod.ts           # request/response Zod schemas
    │   ├── books.types.ts         # internal types (re-exports Drizzle inferred types)
    │   └── books.test.ts          # service-layer + integration tests
    ├── chats/
    │   └── ...
    └── documents/
        └── ...
```

### Why this layout

- **Platform code is shared.** `db/`, `middleware/`, `routes/`, `lib/` are the framework on which features are built. They change rarely and are loaded by every feature.
- **Features are self-contained.** A sub-agent building the `chats` feature loads only `features/chats/` plus the platform — not `features/books/`. This shrinks context and reduces cross-feature breakage.
- **The 4-layer split lives inside each feature.** `routes.ts → controller.ts → service.ts → db/schema.ts`. No skipping layers. Controllers never touch the database directly. Services never send HTTP responses.
- **Schema stays in `db/schema.ts`.** All tables live in one file because (a) Drizzle migrations expect a single schema source, (b) cross-feature foreign keys (`chats.bookId → books.id`) need a shared declaration site, (c) AI agents handle one schema file better than many. The cost is "feature ownership of its table" — we accept that tradeoff.
- **Seeds live in `db/seeds/<entity>.seed.ts`.** One file per entity; the seed runner walks the directory.

### Naming rules

- Folder name = singular feature concept in plural (`books`, `chats`, `documents`). Match the table name.
- File names use dot-suffix to communicate role: `books.routes.ts`, `books.service.ts`. **Not** `index.ts` everywhere — `import { BookService } from './features/books/books.service'` reads better than `from './features/books'` and avoids the "everything is index.ts" navigation problem.
- Class/object exports use PascalCase: `export const BookService = { ... }`.

## Backend: Layer Responsibilities

### Routes (per feature)
Defines endpoints, attaches validation middleware, delegates to controller. No business logic.

```typescript
// features/books/books.routes.ts
import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { BookController } from './books.controller';
import { createBookSchema, updateBookSchema } from './books.zod';

export const booksRouter = Router();
booksRouter.post('/',  validate({ body: createBookSchema }), BookController.create);
booksRouter.get('/:id', BookController.getById);
booksRouter.put('/:id', validate({ body: updateBookSchema }), BookController.update);
booksRouter.delete('/:id', BookController.delete);
```

### Controller (per feature)
Parses HTTP input, calls service, maps result to HTTP response. Never throws; never touches the database.

```typescript
// features/books/books.controller.ts
export const BookController = {
  async create(req: Request, res: Response): Promise<void> {
    const result = await BookService.create(req.body);
    if (!result.ok) {
      res.status(mapErrorToStatus(result.error.code)).json({
        success: false,
        error: result.error,
      });
      return;
    }
    res.status(201).json({ success: true, data: result.data });
  },
  // ...
};
```

### Service (per feature)
Business logic. Returns `ServiceResult<T>`. Never throws (per `error-handling.md`). Imports from `db/schema.ts`.

```typescript
// features/books/books.service.ts
import { db } from '../../db/client';
import { books } from '../../db/schema';

export const BookService = {
  async create(input: CreateBookInput): Promise<ServiceResult<Book>> {
    const [book] = await db.insert(books).values(input).returning();
    return { ok: true, data: book };
  },
  // ...
};
```

### Database (platform)
Drizzle schema in `db/schema.ts`. snake_case columns, camelCase TypeScript. Cross-feature relations in `db/relations.ts`.

```typescript
// db/schema.ts
export const books = pgTable('books', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: varchar('title', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type Book = typeof books.$inferSelect;
export type NewBook = typeof books.$inferInsert;
```

### Seeds (platform)
One file per entity in `db/seeds/`. Each exports a `seed()` function. A top-level `db/seed.ts` runs them in dependency order.

```typescript
// db/seeds/books.seed.ts
import { db } from '../client';
import { books } from '../schema';

export async function seedBooks() {
  await db.insert(books).values([
    { title: 'Sample Book', description: 'For local dev' },
  ]).onConflictDoNothing();
}
```

```typescript
// db/seed.ts
import { seedBooks } from './seeds/books.seed';
import { seedSystemPrompts } from './seeds/system-prompts.seed';

async function main() {
  await seedSystemPrompts();   // dependency-first
  await seedBooks();
}
main();
```

## Frontend: Component → Hook → API Client

Same vertical-slice principle on the frontend, scaled down.

```
client/src/
├── theme.ts                   # PLATFORM: MUI theme generated from design.md
├── api/
│   └── client.ts              # PLATFORM: fetch wrapper
├── routes/
│   └── index.tsx              # PLATFORM: react-router config
├── components/                # PLATFORM: shared UI atoms (Button, Card)
└── features/
    ├── books/
    │   ├── BooksPage.tsx
    │   ├── BookCard.tsx
    │   ├── useBooks.ts         # TanStack Query hooks
    │   └── books.types.ts
    └── chats/
```

### API Client (platform)
Single fetch wrapper. All hooks use this.

```typescript
export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body: unknown) => apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => apiFetch<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};
```

### Hooks (per feature)
One file per resource. Handle cache invalidation.

```typescript
// features/books/useBooks.ts
export function useCreateBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBookInput) => api.post<Book>('/api/books', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['books'] }),
  });
}
```

## Single Responsibility Principle — what each layer guarantees

| Layer | Responsibility | Forbidden |
|---|---|---|
| Route | Endpoint URL + method, attach validation, call controller | Business logic, DB access, response shaping |
| Controller | Parse request, call service, shape HTTP response | Throwing (must use ServiceResult), DB access, business decisions |
| Service | Business logic, DB access via Drizzle, return Result | HTTP concerns (req/res), throwing, returning raw rows past its boundary |
| Schema (db/) | Drizzle tables + types | Business logic, validation rules (those are in Zod) |
| Zod (per feature) | Request/response validation | Business rules (those are in service) |

Cross-cutting concerns that don't fit a single feature live in `lib/` (shared types/helpers) or `middleware/` (request-time behaviors).

## Why "features" and not "modules" or "services"

- "service" is already the layer name *inside* a slice (`books.service.ts`). Overloading the directory would be confusing.
- "module" is too generic — every TS file is a module.
- "feature" communicates intent: each subdirectory is one user-facing capability.
