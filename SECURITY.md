# Security

Please report security vulnerabilities through a private repository security advisory rather than a public issue.

Phase executes coding agents with filesystem/tool access. Treat untrusted adapter manifests, workflow validation commands, model outputs, and repositories as untrusted code. Linux isolation is defense in depth; review the threat model before using Phase with sensitive credentials or production infrastructure.

Never include secrets in public research corpora. Canonical Phase packets are intentionally narrow, but workflow text and symbol dictionaries may still contain project-sensitive labels.
