# Security

Report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open public issues for security problems.

Supported: the latest release.

In scope: the server (sessions, sign-in, the origin and host checks, the run call), the browser app, and the install scripts. The model key must never reach a browser in server modes, and the server must be usable for nothing but System One calls to the configured model; a way around either is a vulnerability. In Pages mode the visitor's own key stays in their browser storage and is sent only to the endpoint they entered.
