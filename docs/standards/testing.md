# Testing Standard

## Rules

- Every new function gets tests. No exceptions.
- Test behavior, not implementation. Tests should survive refactoring.
- Test unhappy paths: invalid input, not found, duplicates, edge cases.
- Unit tests must run in <100ms each.
- Co-locate test files: `book.service.ts` → `book.service.test.ts`

## What to Test

### Services
Test every result path — success AND each error variant.

```typescript
describe('BookService.getById', () => {
  it('returns book when found', async () => {
    // setup: insert a book
    const result = await BookService.getById(bookId);
    expect(result.ok).toBe(true);
    expect(result.data.title).toBe('Test Book');
  });

  it('returns NOT_FOUND when book does not exist', async () => {
    const result = await BookService.getById('nonexistent-id');
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
```

### Validation Schemas
Test valid input, invalid input, and edge cases.

```typescript
describe('createBookSchema', () => {
  it('accepts valid input', () => {
    const result = createBookSchema.safeParse({ title: 'My Book' });
    expect(result.success).toBe(true);
  });

  it('rejects empty title', () => {
    const result = createBookSchema.safeParse({ title: '' });
    expect(result.success).toBe(false);
  });
});
```

### API Routes
Test request/response mapping and status codes.

### Middleware
Test that validation rejects bad input before it reaches the controller.

## What NOT to Test

- Third-party library internals
- TypeScript type system (use tsd for type tests if needed)
- Database column names existing (that's migration's job)
