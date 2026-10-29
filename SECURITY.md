# Security

Blender Pilot v0.1.0 is intended for a trusted operator and trusted local network. It is not a hardened multi-tenant sandbox. Blender scripts and agent tools can modify project data; install only skills and assets you trust.

Use HTTPS for remote access, a strong login password, and private PostgreSQL/MCP/runner listeners. The native launcher binds the API and runner to loopback by default. Back up PostgreSQL together with the data directory and its encryption material. Model providers receive the prompts and references sent to them.

Do not post credentials, private scenes, or exploit details in public issues. Use the repository's private vulnerability reporting channel if enabled; otherwise contact the maintainer privately before disclosing details. We do not currently offer a security response SLA. Only the initial 0.1.x development line is maintained.
