# Security

Please report security vulnerabilities through a private repository security advisory rather than a public issue.

## Raw data is intentionally raw

Phase preserves child stdout/stderr and launch arguments because post-hoc redaction would mutate the research record. **Do not put secrets in command-line arguments or intentionally print secrets into a Phase-managed process.** Prefer environment variables, secret files, OS keyrings, or the secret mechanism already used by the deployment platform.

Treat a Phase run directory as potentially sensitive operational data. Run directories are created private (`0700`) and Unix control sockets are restricted (`0600`) by default, subject to the host filesystem and account model.

Do not publish or upload a corpus until its source runs are appropriate for sharing. A Phase corpus is an integrity index, not a privacy scrubber.

## Process control

Phase can signal an entire Unix process group. Anyone who can access the run's control socket can pause, resume, terminate, or kill that workload. Protect `PHASE_HOME` using normal OS ownership and filesystem permissions.

## Research / agent execution

Phase can execute coding agents and arbitrary commands with the permissions of the invoking account. Treat untrusted repositories, agent outputs, adapter manifests, workflow validation commands, and generated scripts as untrusted code.

The Linux isolation layer in the allocator research path is defense in depth, not a substitute for normal production sandboxing and least privilege.
