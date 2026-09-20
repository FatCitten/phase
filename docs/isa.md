# Phase ISA v1

Phase ISA is a deliberately small scheduling instruction set. It is not native CPU machine code; it is a portable bytecode for allocating cognition.

## File format

A `.phasebin` file contains a 64-byte header followed by fixed 32-byte little-endian records.

### Header

| Offset | Bytes | Meaning |
|---:|---:|---|
| 0 | 4 | ASCII `PHB1` |
| 4 | 2 | ISA version |
| 6 | 2 | record width (`32`) |
| 8 | 1 | stream: control=1, signal=2, state=3 |
| 9 | 1 | endian marker (`1` = little) |
| 10 | 2 | header width (`64`) |
| 12 | 8 | creation Unix milliseconds |
| 20 | 16 | SHA-256-derived run fingerprint |
| 36 | 16 | truncated seed hash |
| 52 | 8 | reserved zeroes |
| 60 | 4 | CRC32 of bytes 0..59 |

### Record

| Offset | Bytes | Meaning |
|---:|---:|---|
| 0 | 1 | opcode |
| 1 | 1 | flags |
| 2 | 2 | fiber number |
| 4 | 4 | stream-local sequence |
| 8 | 4 | monotonic milliseconds from shared run clock |
| 12 | 4 | operand A |
| 16 | 4 | operand B |
| 20 | 8 | signed value |
| 28 | 4 | CRC32 of bytes 0..27 |

The compact record is designed to be mmap-friendly and deterministic. Human labels live in the separately hashed `symbols.ndjson` dictionary.

## Control opcodes

`BOOT`, `FORK`, `ROUTE`, `ALLOC`, `GRANT`, `MAPCTX`, `RUN`, `GATE`, `BLOCK`, `COMPLETE`, `FAIL`, `RELEASE`, `HALT`.

`ALLOC` operand A names a typed resource: context tokens, token budget, wall milliseconds, tool calls, money microunits, human-attention microunits, parallel slots, or retry budget.

## State opcodes

`STATE_REPO` identifies the hard repository domain represented by the state vector. `STATE_FEATURE` stores one fixed-point feature value: `value / 1,000,000`, with feature index in operand A and vector width in operand B.

## Signal opcodes

Signals describe observations, never desired behavior: worker success/failure, validation pass/fail, wall milliseconds, allocated context/tool/token budgets, context misses, retries, human requests, errors, lifecycle progress, and stop.

Signals that cannot be measured by a selected agent adapter are absent rather than invented.
