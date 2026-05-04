# API Conventions Standard

## Validation Middleware

Zod at every API boundary. Validate before the controller runs.

```typescript
import { z } from 'zod';

// Schema
export const createBookSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
});
export type CreateBookInput = z.infer<typeof createBookSchema>;

// Middleware
function validate(schemas: { body?: z.ZodSchema; query?: z.ZodSchema; params?: z.ZodSchema }) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: result.error.issues[0].message },
        });
        return;
      }
      req.body = result.data;
    }
    // Same for query, params
    next();
  };
}

// Usage
router.post('/', validate({ body: createBookSchema }), BookController.create);
```

## Route Organization

One route file per resource. Mount under `/api`.

```typescript
// server/src/routes/book.routes.ts
const router = Router();
router.get('/', BookController.list);
router.post('/', validate({ body: createBookSchema }), BookController.create);
router.get('/:id', BookController.getById);
router.put('/:id', validate({ body: updateBookSchema }), BookController.update);
router.delete('/:id', BookController.remove);
export { router as bookRoutes };

// server/src/index.ts
app.use('/api/books', bookRoutes);
```
