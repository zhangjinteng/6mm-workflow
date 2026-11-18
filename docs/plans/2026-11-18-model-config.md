# Model Configuration Implementation Plan

Goal: Add a local model management page backed by the existing workflow MongoDB database, without Redis or AIProxy.

Architecture: Next.js route handlers protect all management APIs with local/same-origin checks. A MongoDB repository stores complete model configuration and separate plaintext credentials as explicitly requested by the user. A single defaults document stores model references atomically so standalone MongoDB is sufficient; API isDefault values are derived. Soft deletion preserves recovery. Provider presets are local configuration, not a dependency on the source plugin service.

Scope: provider selection, custom model ID, display name, model type, endpoint, parameters and capabilities, save/edit, enable/disable, default selection, explicit connectivity tests, search/filter, responsive UI.

Security: database credentials stay in ignored .env.local; model API keys are plaintext in workflow16080_credentials.apiKey per the user's revised requirement. Never return keys or upstream response bodies. Management APIs are local only. Connectivity tests require explicit confirmation, restrict outbound hosts and redirects, have timeouts and bounded response reading. No automatic paid provider tests. Legacy ciphertext is converted with a one-time migration using the original key; normal operation no longer uses MODEL_CREDENTIAL_KEY.

Implementation checklist:
- [x] Add MongoDB driver and icon dependency.
- [x] Add configuration schema, provider presets, local API guard and credential storage (revised to plaintext by user request).
- [x] Add repository with optimistic revision checks, soft deletion and atomic default references.
- [x] Add model management and explicit connectivity test APIs.
- [x] Add /models interface and home entry.
- [x] Configure supplied MongoDB connection and verify only new collections.
- [x] Add unit/security tests and verify API integration with disposable records.
- [x] Run lint, typecheck, tests and production build; inspect desktop/mobile UI.

Implementation notes: Prefer a small independent configuration module over importing the source application's MongoDB/cache/plugin bootstrap. Credentials and existing source/business data are not copied. Presets are examples, not claims about currently available upstream models; arbitrary upstream IDs remain supported. Provider protocols are explicit; unsupported authentication (such as AWS signing) is not misrepresented as OpenAI-compatible.
