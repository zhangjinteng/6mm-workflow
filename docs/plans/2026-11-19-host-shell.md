# Local Host Shell

Scope: retain the existing virtual sandbox and add an explicit host_shell Agent tool and /shell console. Do not reinterpret sandbox_shell or expose virtual Skill paths as host paths.

Modes: isolated-shell (default, host execution disabled), host-shell (only a tiny fixed set of diagnostic commands runs automatically; all other commands require one-use approval), danger-full-access (explicit local opt-in, no per-command approval). Mode changes never come from tool parameters. Existing WORKFLOW_SANDBOX_MODE=workspace-write and WORKFLOW_HOST_SHELL_DISABLED=1 disable host execution.

Execution: real /bin/sh -c, canonical working directory, bounded output, timeout, process-group termination, minimal environment, no automatic retry. MongoDB jobs bind exact command, cwd, timeout, policy revision, request/tool-call identity and approval. Pending requests expire. Restarted/uncertain jobs are not rerun. Agent pauses for approval and resumes by replaying the persisted result.

Security: this is not OS isolation. cwd is not an access boundary. Full access has the permissions of the server's OS account and can access files, network and credentials. Local-only guards remain; logs are redacted, pending raw payloads are removed after termination, and no public listener is added. Initial verification must restore isolated mode and use disposable, harmless commands only.

- [x] Add policy, persistent jobs, redaction and host process runner.
- [x] Add local policy, execution, approval, cancellation and log APIs.
- [x] Integrate explicit host_shell selection and Agent approval/resume.
- [x] Add /shell console, mode controls, approval and execution history.
- [x] Add regression/integration tests and document interfaces.
- [x] Verify build, desktop/mobile UI and isolated-mode regression.

Verification: 143 unit/route tests, host integration including real HTTP controls and synthetic default/Pi Agent approval/resume, nine isolated sandbox regressions, 21 original node routes plus four failure cases, lint, typecheck and production build passed. No paid model request was made. Disposable integration jobs and credentials were removed; the UI's harmless isolated pwd record remains. Final policy is isolated-shell, with the real project directory configured for a future explicit host-mode opt-in.
