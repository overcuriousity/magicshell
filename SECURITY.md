# Security

Report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open public issues for security problems.

Supported: the latest release.

In scope: the server (sessions, sign-in, the origin and host checks, the run and embedding calls), the browser app, and the install scripts. Model keys must never reach a browser, visitors cannot choose models or endpoints, and the server must be usable for nothing but System One calls to the configured decision model and embedding calls to the configured embedding model; a way around any of these is a vulnerability.
