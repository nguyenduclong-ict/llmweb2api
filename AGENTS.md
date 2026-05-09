# AGENTS.md

## Sau khi sửa code, chạy các lệnh sau

### Backend

```bash
pnpm typecheck:backend   # Kiểm tra TypeScript
pnpm lint:backend        # ESLint check src/
pnpm format:check:backend # Prettier check
```

Hoặc chạy cả 3:

```bash
pnpm check               # typecheck + lint + format:check tất cả
```

### Frontend

```bash
pnpm typecheck:web       # Kiểm tra TypeScript
pnpm lint:web            # ESLint check
pnpm format:check:web    # Prettier check
```

### Auto-format code

```bash
pnpm format:backend      # Format backend (alias: pnpm format)
pnpm format:web          # Format frontend
pnpm format:all          # Format cả 2
```

### Lint

```bash
pnpm lint:backend        # ESLint backend (alias: pnpm lint)
pnpm lint:web            # ESLint frontend
pnpm lint:all            # ESLint cả 2
```
