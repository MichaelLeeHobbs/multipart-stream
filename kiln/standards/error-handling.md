# Error Handling Standard

## Why these rules are strict

The AIRA audit (2026) found AI-attributed code produces ~42% more exception-handling defects than human-written code. The training-signal explanation: a swallowed exception "looks correct" to raters, so models bias toward fallback returns (`return null`, `return []`, `return {}`). Every rule below is enforced — by lint, by review, or by both — to prevent that drift.

## MUST: Services return Result; never throw

Service-layer functions that can fail return `ServiceResult<T>`. Throwing from a service is a bug.

```typescript
type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
```

### Service example

```typescript
async function getById(id: string): Promise<ServiceResult<Book>> {
  const [book] = await db.select().from(books).where(eq(books.id, id));
  if (!book) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `Book ${id} not found` } };
  }
  return { ok: true, data: book };
}
```

### Controller example

```typescript
const result = await BookService.getById(req.params.id);
if (!result.ok) {
  res.status(mapErrorToStatus(result.error.code)).json({
    success: false,
    error: result.error,
  });
  return;
}
res.json({ success: true, data: result.data });
```

## MUST NOT: Silent catch with fallback return

The single most common AI failure mode. **Forbidden** patterns:

```typescript
// FORBIDDEN — silent failure, masks the bug, no log, no propagation
try {
  return await service.doThing();
} catch (e) {
  return null;
}

// FORBIDDEN — same problem, dressed up
try {
  return await service.doThing();
} catch (e) {
  return [];
}

// FORBIDDEN — empty object fallback
try {
  return await JSON.parse(input);
} catch (e) {
  return {};
}

// FORBIDDEN — discarding the error
try {
  return await service.doThing();
} catch {
  return defaultValue;
}
```

## MUST: Every catch does at least one of {re-throw, return Result error, structured log}

A `catch` block must do at least one of:

1. **Re-throw** (after augmenting the error with context):
   ```typescript
   } catch (e) {
     throw new Error(`Failed to load book ${id}: ${e instanceof Error ? e.message : String(e)}`);
   }
   ```

2. **Return a Result error** (with a real code, not a fallback value):
   ```typescript
   } catch (e) {
     logger.error({ err: e, bookId: id }, 'Failed to load book');
     return { ok: false, error: { code: 'INTERNAL', message: 'Failed to load book' } };
   }
   ```

3. **Structured log + propagate** (if the catch is purely diagnostic, e.g., at a top boundary):
   ```typescript
   } catch (e) {
     logger.error({ err: e, requestId }, 'Unhandled error in route');
     throw e;
   }
   ```

A `catch` block that does NONE of these is a lint failure.

## Lint enforcement

Add the following to `.eslintrc.json` (or biome equivalent):

```json
{
  "rules": {
    "no-empty": ["error", { "allowEmptyCatch": false }],
    "@typescript-eslint/no-throw-literal": "error",
    "@typescript-eslint/no-unsafe-return": "error",
    "@typescript-eslint/only-throw-error": "error"
  }
}
```

Plus a custom rule (or grep gate in CI) that flags:
- `catch (...) { return null }` / `return []` / `return {}` / `return undefined`
- `catch (...) {}` with no body
- `catch` without an inner `logger.` call AND no `throw` AND no `return { ok: false`

## Error Code → HTTP Status

```typescript
const ERROR_STATUS_MAP: Record<string, number> = {
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  INVALID_INPUT: 400,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

function mapErrorToStatus(code: string): number {
  return ERROR_STATUS_MAP[code] ?? 500;
}
```

## API Response Envelope

All endpoints return a consistent shape:

```typescript
// Success
{ success: true, data: T }

// Error
{ success: false, error: { code: string, message: string } }
```

## Express Error Middleware

Catch unhandled errors at the top level. Never leak stack traces.

```typescript
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL', message: 'Internal server error' },
  });
});
```

## Quick reference: forbidden vs required

| Forbidden | Required |
|---|---|
| `catch (e) { return null }` | `catch (e) { logger.error(...); return { ok: false, error: { code: 'INTERNAL', ... } } }` |
| `catch {}` | `catch (e) { logger.error(...); throw e }` |
| `try { ... } catch (e) { return [] }` | `try { ... } catch (e) { logger.error(...); return { ok: false, ... } }` |
| Throwing from a service | Returning `ServiceResult<T>` |
| Generic `Error` with no context | `Error` with the operation that failed in the message |
