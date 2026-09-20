# Concepts

## Workflow
Human intent compiled into explicit objectives, dependencies, constraints, validation gates, and resource ceilings.

## Fiber
A temporary allocation of cognition. A fiber owns an objective and receives an execution backend, context budget, tool capabilities, time, and other resources. It is disposable after its measurable outcome is recorded.

## TPM allocator
A small model or deterministic control policy that answers: how much, where, for whom, to do what, for how long, then what? It is not project memory and it does not produce project code.

## Phase VM
The runtime that enforces capability/resource ceilings and executes Phase ISA decisions through agent adapters.

## State bus
The exact numerical input state presented to allocation policy.

## Control bus
What the allocator/runtime chose to allocate and execute.

## Signal bus
What the environment measurably returned.
