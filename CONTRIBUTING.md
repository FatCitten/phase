# Contributing

Phase treats dataset integrity as a compatibility boundary.

Changes to the ISA, packet encoding, signal semantics, state-vector construction, corpus derivation, or "unobserved vs zero" behavior require tests and a schema/version decision. Never silently reinterpret an existing opcode or measurement field.

Before submitting changes:

```bash
npm test
npm run bench
```

A derived analysis feature should consume canonical data; it should not mutate canonical run files.
