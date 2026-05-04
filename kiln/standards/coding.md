# Coding Standard

## TypeScript

- No `any`. Use `unknown` with type guards or generics.
- No enums. Use `as const` objects or string literal unions.
- Explicit return types on exported functions.
- ESM imports throughout. Use `.js` extensions in import paths.

## Error Handling

- Services never throw. Return `ServiceResult<T>`.
- `throw` is reserved for programmer errors (bugs), not expected failures.
- All async operations need error handling. Never let promises float.

## Functions

- Keep functions focused and small.
- Prefer early returns over deep nesting.
- Limit parameters. Use an options object for 4+.

## Naming

- **Files:** kebab-case for utilities, PascalCase for classes/components.
- **Database columns:** snake_case.
- **TypeScript properties:** camelCase.
- **Types/Interfaces:** PascalCase.
- **Constants:** UPPER_SNAKE_CASE for true constants, camelCase for config.

## Imports

```typescript
// Prefer inline type imports
import { type Book } from './types.js';

// Group: external → internal → types
import express from 'express';
import { db } from '../db/index.js';
import { type ServiceResult } from '../types.js';
```
