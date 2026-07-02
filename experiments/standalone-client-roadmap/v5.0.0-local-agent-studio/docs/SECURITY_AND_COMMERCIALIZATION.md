# Studio v5 Security and Commercialization

## English

### Security Boundaries

Local Agent Studio is a privileged coding agent. Treat model output, workspace
content, MCP tool descriptions, downloaded dependencies, and remote endpoints
as untrusted input.

The Preview implements these baseline controls:

1. The local HTTP server only accepts loopback peers and loopback Host headers.
2. Every private API call requires a random per-process capability token.
3. Browser requests with a foreign Origin are rejected.
4. State-changing requests require `application/json`, which blocks simple
   cross-origin form or `text/plain` attacks.
5. CSP, anti-framing, no-sniff, no-referrer, and restrictive permissions
   headers are applied.
6. Remote MCP endpoints are disabled unless the operator explicitly opts in.
7. The Electron renderer runs with `nodeIntegration=false`,
   `contextIsolation=true`, sandboxing enabled, denied permission prompts, and
   local-only navigation.
8. Support bundles recursively redact credentials and omit raw tool arguments
   and results from the event list.
9. SQLite persists threads without putting API credentials in the database.

This is defense in depth, not an operating-system sandbox. The Stable desktop
app still needs typed IPC, OS-enforced workspace boundaries, network allowlists,
signed installers, signed update manifests, and platform code signing before
customer release.

### Commercial License Design

The admin does not give customers a shared secret. The admin license service
signs a customer-specific token with an Ed25519 private key. The app contains
only the matching public key and can verify the token offline.

Required claims:

- `product`: `local-agent-studio`
- `licenseId`
- `customerId`
- `edition`
- optional `issuedAt`, `notBefore`, `expiresAt`, and `features`

Preview builds are intentionally allowed without a license. Stable builds are
fail-closed: a missing verification key, missing token, invalid signature, wrong
product, incomplete claims, future activation date, or expiration denies model
execution.

The private license key belongs in an offline signing environment or a managed
KMS/HSM. Never put it in source code, environment defaults, CI logs, release
archives, customer machines, or command-line arguments.

### Release Integrity and Anti-Backdoor Controls

License signing and release signing use separate Ed25519 keys. Compromise of a
license issuer must not authorize software updates.

The release pipeline must:

1. Install dependencies from the lockfile with `npm ci`.
2. Reject install/prepare lifecycle scripts unless explicitly reviewed.
3. Run syntax checks, unit tests, HTTP security tests, dependency audit, and
   `security:audit` on Windows, macOS, and Linux.
4. Generate a SHA-256 integrity manifest for production runtime files.
5. Sign the integrity manifest outside the repository.
6. Build in an isolated CI runner from a reviewed commit.
7. Generate an SBOM and provenance attestation.
8. Sign Windows, macOS, and Linux release artifacts with platform-appropriate
   signing identities.
9. Publish checksums and verify them before installation/update.
10. Require a separately signed update manifest and support rollback.

Pattern scanning cannot prove that software has no backdoor. Review, least
privilege, reproducible inputs, signed provenance, platform code signing,
runtime isolation, and transparent release evidence are all required.

### Planned Stable Controls

- Typed, allowlisted IPC instead of privileged localhost APIs.
- OS keychain storage for provider credentials and license tokens.
- OS-enforced workspace write boundaries.
- Network disabled by default for model-generated commands.
- One-time approvals for destructive, network, install, and out-of-root actions.
- Device activation, revocation, offline grace periods, and privacy-preserving
  license refresh.
- Signed auto-update with staged rollout and automatic rollback.
- External security review and release penetration test.

---

## Tiếng Việt

### Ranh Giới Bảo Mật

Local Agent Studio là coding agent có quyền cao. Phải xem model output, nội dung
workspace, mô tả MCP tool, dependency tải về và remote endpoint là dữ liệu không
đáng tin cậy.

Preview hiện có các lớp bảo vệ cơ bản:

1. HTTP server local chỉ chấp nhận loopback peer và loopback Host header.
2. Mọi private API yêu cầu capability token ngẫu nhiên theo từng tiến trình.
3. Request trình duyệt có Origin lạ bị từ chối.
4. Thao tác thay đổi chỉ nhận `application/json`, giúp chặn form hoặc request
   `text/plain` cross-origin đơn giản.
5. App gửi CSP, anti-framing, no-sniff, no-referrer và permissions policy chặt.
6. Remote MCP bị tắt trừ khi operator chủ động bật.
7. Electron renderer chạy với `nodeIntegration=false`, `contextIsolation=true`,
   sandbox bật, permission prompt bị từ chối và chỉ cho điều hướng local.
8. Support Bundle redaction đệ quy và bỏ raw tool args/results khỏi event list.
9. SQLite lưu thread nhưng không lưu API credential.

Đây là defense in depth, chưa phải sandbox cấp hệ điều hành. Trước khi phát hành
Stable cho khách, desktop app vẫn cần typed IPC, workspace boundary do hệ điều
hành cưỡng chế, network allowlist, signed installer, signed update manifest và
platform code signing.

### Thiết Kế License Thương Mại

Admin không đưa cho khách một shared secret. License service của admin ký token
riêng cho từng khách bằng Ed25519 private key. App chỉ chứa public key tương ứng
để xác minh offline.

Claims bắt buộc:

- `product`: `local-agent-studio`
- `licenseId`
- `customerId`
- `edition`
- có thể thêm `issuedAt`, `notBefore`, `expiresAt` và `features`

Preview được phép chạy không cần license. Stable fail-closed: thiếu verification
key, thiếu token, chữ ký sai, sai product, claims thiếu, chưa đến ngày kích hoạt
hoặc đã hết hạn đều không được chạy model.

Private license key phải nằm trong môi trường ký offline hoặc KMS/HSM. Tuyệt đối
không đặt trong source, env mặc định, CI log, release archive, máy khách hoặc
command-line argument.

### Release Integrity Và Chống Backdoor

Khóa ký license và khóa ký release phải là hai cặp khóa khác nhau. Mất khóa cấp
license không được phép biến thành quyền phát hành bản update.

Release pipeline phải:

1. Cài dependency từ lockfile bằng `npm ci`.
2. Từ chối install/prepare lifecycle script nếu chưa review rõ ràng.
3. Chạy syntax check, unit test, HTTP security test, dependency audit và
   `security:audit` trên Windows, macOS và Linux.
4. Tạo SHA-256 integrity manifest cho các file runtime production.
5. Ký integrity manifest ở bên ngoài repository.
6. Build trong CI runner cô lập từ commit đã review.
7. Tạo SBOM và provenance attestation.
8. Ký artifact Windows, macOS và Linux bằng signing identity phù hợp từng nền tảng.
9. Công bố checksum và verify trước khi install/update.
10. Yêu cầu update manifest được ký riêng và hỗ trợ rollback.

Pattern scanner không thể tự chứng minh app không có backdoor. Cần kết hợp code
review, least privilege, input build có thể truy vết, signed provenance, platform
code signing, runtime isolation và bằng chứng release minh bạch.

### Stable Còn Cần Gì

- Typed IPC có allowlist thay cho privileged localhost APIs.
- OS keychain để lưu provider credential và license token.
- Workspace write boundary do hệ điều hành cưỡng chế.
- Tắt network mặc định cho command do model sinh ra.
- Approval một lần cho hành động destructive, network, install và out-of-root.
- Device activation, revocation, offline grace period và license refresh bảo vệ quyền riêng tư.
- Signed auto-update có staged rollout và automatic rollback.
- Security review bên ngoài và penetration test trước release.
