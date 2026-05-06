# AGENTS.md

## Sau khi sửa code, chạy các lệnh sau

### Backend

```bash
pnpm typecheck         # Kiểm tra TypeScript
pnpm lint              # ESLint check src/
pnpm format:check      # Prettier check
```

Hoặc chạy cả 3:

```bash
pnpm check             # typecheck + lint + format:check
```

### Frontend

```bash
cd ui
pnpm typecheck
pnpm lint
pnpm format:check
```

### Auto-format code

```bash
pnpm format            # Format backend
pnpm format:ui         # Format frontend
pnpm format:all        # Format cả 2
```

### Lint cả 2

```bash
pnpm lint:all          # ESLint backend + frontend
```
