# Development Rules

## Before Coding

Before implementing a feature:

1. Read STACK.md.
2. Read ARCHITECTURE.md.
3. Read the relevant feature document.
4. Check existing code before creating new files.
5. Follow existing naming conventions.

Do not start implementing a feature based only on the user prompt.

---

# Implementation Process

For each feature:

1. Define/update database entities.
2. Create migration.
3. Create DTOs.
4. Implement repository.
5. Implement service.
6. Implement controller.
7. Add authorization.
8. Add tests.
9. Update documentation if behavior changed.

---

# Coding Rules

Prefer readable code over clever code.

Good:

```ts
const appointment = await repository.findById(id);
if (!appointment) {
  throw new NotFoundException('Appointment not found');
}
```

Avoid unnecessarily abstract code such as:

return this.executor.execute(
  this.policyFactory.create(
    this.strategyResolver.resolve(...)
  )
);

unless there is a real requirement for it.

---

# Error Handling

Use appropriate NestJS exceptions.

Examples:

- BadRequestException
- UnauthorizedException
- ForbiddenException
- NotFoundException
- ConflictException

Use ConflictException for booking conflicts.

---

# Configuration

Environment-specific configuration must come from environment variables.

Do not hardcode:

- database passwords
- JWT secrets
- Redis credentials
- production URLs

Provide .env.example.

---

# Database

Never enable:

synchronize: true

Database structure must be managed using migrations.

---

# Testing

Unit and e2e tests run through `@swc/jest`, not `ts-jest`. Several NestJS
packages (including `@nestjs/typeorm`) ship as ESM; `ts-jest` cannot load them
when transforming test files. SWC transpiles without type-checking, so a passing
test suite does not prove the TypeScript compiles.

Run type-checking separately:

```bash
npm run typecheck
```

This uses `tsconfig.typecheck.json`, which includes both `src/` and `test/`.
`npm run build` type-checks `src/` only (via `tsconfig.build.json`). Run both
before declaring a plan complete.

---

# Git

Use meaningful commits.

Examples:

- feat(auth): add JWT authentication

- feat(appointments): implement appointment booking

- feat(appointments): protect slot booking with database constraint

- feat(waiting-list): add waiting list processing

- test(appointments): add concurrent booking test

- docs: document concurrency strategy

Avoid one giant commit containing the entire project.

---

# AI Coding Rule

The AI agent must:

- follow this architecture
- inspect existing code before modifying it
- avoid unnecessary abstractions
- explain important architectural decisions
- never silently change an established business rule
- add tests for important business behavior
- keep implementation understandable enough to explain during an interview