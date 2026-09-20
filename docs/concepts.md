# Concepts

## Run

One operating-system process tree observed by Phase. A run has an immutable launch specification, a single ordered event stream, byte-exact stdout/stderr captures, mutable operational metadata, and an optional final seal.

## Event

The smallest shared truth in the process runtime. Events are sequential and SHA-256 hash chained. They record measured lifecycle/resource activity, control requests, byte ranges emitted by the process, and sparse structured signals explicitly emitted by software inside the run.

## Control socket

A run-local IPC endpoint. External Phase commands send pause/resume/stop/kill and `emit` requests to the supervisor through this socket so only one writer owns the canonical event sequence.

## Corpus

A content-addressed index of verified sealed runs. A corpus is not a cleaned rewrite of the source logs.

## Fiber

In the allocator research layer, a fiber is a temporary allocation of cognition. The process runtime does not require fibers; ordinary programs can be observed without accepting Phase's research abstractions.

## TPM allocator

A small model or deterministic policy that can learn allocation decisions from measured state → control → outcome trajectories. It is not project memory and does not produce project code.

## Phase ISA

The low-level research instruction vocabulary used by the allocator path. It remains available beneath the simpler process/logging interface.
