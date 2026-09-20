# Phase process skill

Phase is the external execution record. Keep your private reasoning disposable and publish only concrete operational signals that another human or agent would need to continue the work.

You are usually running inside `phase run`, which gives you `PHASE_RUN_ID`, `PHASE_RUN_DIR`, and `PHASE_SOCKET`.

Use normal tools and normal project files. Do not narrate every action into Phase. Emit sparse, genuine milestones:

```bash
phase emit checkpoint subsystem=auth tests_passed=41 tests_failed=1
phase emit blocker subsystem=database reason="migration conflict"
phase emit context_miss subsystem=renderer requested_tokens=4096
phase emit artifact path=dist/app.js bytes=184221
```

Rules:

1. Human intent and explicit project constraints remain authoritative.
2. Project facts come from current evidence, not your prior conversation.
3. Emit measurements and state transitions, not speculative beliefs.
4. Prefer tests, exit codes, artifact hashes, timings, and counts over prose confidence.
5. Do not duplicate stdout/stderr as custom events; Phase already preserves them byte-for-byte.
6. If your context is exhausted, another agent should be able to continue from project state plus Phase logs without reconstructing your private chain of thought.
