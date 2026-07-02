# AGENTS.md — LCA Fullstack Coding Agent Instructions

> **Đây là hướng dẫn vận hành cho ChatGPT Web khi làm việc qua LCA.**
> *This is the operating playbook for ChatGPT Web when acting as a coding agent through LCA (Local Coding Agent) over MCP tunnel.*

---

## 1. Quick Start / Khởi Động Nhanh

### EN
1. Verify the tunnel is alive: call `ping`. If no response, stop — the agent cannot work.
2. Check workspace: call `workspace_info` to confirm the repo root and current branch.
3. For any coding task beyond a trivial one-liner, go to **Section 2 — Required Workflow**.
4. Review `policy` / `profile` if they exist in the workspace (they contain project-specific rules).

### VN
1. Kiểm tra tunnel còn sống: gọi `ping`. Nếu không phản hồi, dừng lại — agent không thể làm việc.
2. Kiểm tra workspace: gọi `workspace_info` để xác nhận thư mục gốc và branch hiện tại.
3. Với bất kỳ tác vụ coding nào không phải one-liner, chuyển sang **Mục 2 — Required Workflow**.
4. Đọc `policy` / `profile` nếu có trong workspace (chúng chứa quy tắc riêng của dự án).

---

## 2. Required Workflow / Quy Trình Bắt Buộc

> **⚠️ MANDATORY — this workflow is NOT optional. Skip it only for trivial one-liner fixes.**

### EN

```
For EVERY non-trivial task:

1. plan_task(task_description)
   → Produce a structured plan with numbered sub-tasks.

2. Present the plan to the user.
   → Wait for confirmation before touching any code.

3. For EACH sub-task (in order):
   a. Write / edit the code (read_file → patch or write_file).
   b. Run tests/lint/build via sandbox_exec (NEVER execute_command).
   c. If tests fail → fix the code → retry sandbox_exec (max 3 retries).
   d. Call review_changes for the sub-task's changes.

4. After ALL sub-tasks are done:
   → Call verify_done with evidence (test output, build logs, screenshots).
   → Report status: DONE (all green) or BLOCKED (explain why).

5. If BLOCKED: ask user for guidance. Do NOT silently abandon.
```

### VN

```
Với MỌI tác vụ không tầm thường:

1. plan_task(mô_tả)
   → Tạo kế hoạch có cấu trúc với các sub-task được đánh số.

2. Trình bày kế hoạch cho người dùng.
   → Chờ xác nhận trước khi chạm vào code.

3. Với TỪNG sub-task (theo thứ tự):
   a. Viết / sửa code (read_file → patch hoặc write_file).
   b. Chạy tests/lint/build qua sandbox_exec (TUYỆT ĐỐI KHÔNG dùng execute_command).
   c. Nếu test fail → sửa code → chạy lại sandbox_exec (tối đa 3 lần thử).
   d. Gọi review_changes cho các thay đổi của sub-task đó.

4. Sau khi HOÀN THÀNH TẤT CẢ sub-tasks:
   → Gọi verify_done với bằng chứng (test output, build logs, ảnh chụp).
   → Báo cáo trạng thái: DONE (tất cả xanh) hoặc BLOCKED (giải thích lý do).

5. Nếu BLOCKED: hỏi người dùng hướng dẫn. KHÔNG âm thầm bỏ cuộc.
```

---

## 3. Tool Selection Guide / Hướng Dẫn Chọn Công Cụ

| Scenario / Tình huống | Tool / Công cụ | Notes / Ghi chú |
|---|---|---|
| Start any non-trivial task | `plan_task` | Always first. / Luôn đầu tiên. |
| Read a file | `read_file` | Offset + limit for large files. |
| Write a whole file | `write_file` | Overwrites entirely. |
| Targeted edit in a file | `patch` (mode=replace) | Safer than write_file for small changes. |
| Multi-file bulk edits | `patch` (mode=patch) | V4A format. |
| Search code content | `search_files` (target=content) | Regex search, ripgrep-backed. |
| Find files by name | `search_files` (target=files) | Glob patterns. |
| Git status / log / diff | git tools (status, log, diff, show) | Use these, not shell git commands. |
| Run tests / lint / build | **`sandbox_exec`** or `quality_gate` | **NEVER `execute_command`** for these. |
| Run a safe one-off shell cmd | `execute_command` | Only for safe commands (echo, ls, mkdir, etc.). |
| Review sub-task changes | `review_changes` | Call after each sub-task. |
| Final verification | `verify_done` | Call after ALL sub-tasks with evidence. |
| Learn about the codebase | `workspace_snapshot`, `workspace_doctor` | Structure overview, health check. |
| Check skill/policy docs | `list_skills`, `read_skill` | Project-specific conventions. |

### EN — Quick Decision Tree
- **Need to understand the task?** → `plan_task`
- **Need to see code?** → `read_file` / `search_files`
- **Need to change code?** → `patch` (small) or `write_file` (whole file)
- **Need to verify?** → `sandbox_exec` (tests) → `review_changes` → `verify_done`

### VN — Sơ Đồ Quyết Định Nhanh
- **Cần hiểu tác vụ?** → `plan_task`
- **Cần xem code?** → `read_file` / `search_files`
- **Cần sửa code?** → `patch` (nhỏ) hoặc `write_file` (cả file)
- **Cần xác minh?** → `sandbox_exec` (tests) → `review_changes` → `verify_done`

---

## 4. Sandbox Rule / Quy Tắc Sandbox

> **🔴 CRITICAL — violation invalidates the entire session.**

### EN
- **ALL tests, linters, builds, type-checks, and compilers MUST run inside `sandbox_exec` or `quality_gate`.**
- `execute_command` is ONLY for safe, non-code-execution shell commands (echo, ls, mkdir, pwd, etc.).
- Rationale: `sandbox_exec` provides isolated, reproducible execution. `execute_command` runs on the host machine with no isolation — a test script that does `rm -rf` or `npm install --global` can damage the user's system.
- If you are unsure whether a command is safe, use `sandbox_exec`.

### VN
- **TẤT CẢ tests, linters, builds, type-checks, compilers PHẢI chạy trong `sandbox_exec` hoặc `quality_gate`.**
- `execute_command` CHỈ dùng cho các lệnh shell an toàn, không thực thi code (echo, ls, mkdir, pwd, v.v.).
- Lý do: `sandbox_exec` cung cấp môi trường thực thi cô lập, có thể tái tạo. `execute_command` chạy trực tiếp trên máy chủ không có cô lập — một test script có `rm -rf` hoặc `npm install --global` có thể phá hủy hệ thống của người dùng.
- Nếu không chắc một lệnh có an toàn không, hãy dùng `sandbox_exec`.

---

## 5. Verification Rule / Quy Tắc Xác Minh

> **🔴 NEVER claim "done" without calling `verify_done` with real evidence.**

### EN
- After completing ALL sub-tasks in the plan, you MUST call `verify_done`.
- Evidence can include:
  - Test output (pass/fail summary)
  - Build logs (success confirmation)
  - Screenshots or terminal output showing the feature working
  - `quality_gate` results (if configured)
- If `verify_done` fails or evidence is insufficient → fix the gaps → call `verify_done` again.
- Only report **DONE** when `verify_done` passes with all checks green.
- Report **BLOCKED** with a clear explanation if you cannot proceed (missing dependency, ambiguous requirement, outside scope).

### VN
- Sau khi hoàn thành TẤT CẢ sub-tasks trong kế hoạch, PHẢI gọi `verify_done`.
- Bằng chứng có thể bao gồm:
  - Kết quả test (tóm tắt pass/fail)
  - Build logs (xác nhận thành công)
  - Ảnh chụp hoặc output terminal cho thấy tính năng hoạt động
  - Kết quả `quality_gate` (nếu được cấu hình)
- Nếu `verify_done` thất bại hoặc bằng chứng không đủ → sửa các lỗ hổng → gọi lại `verify_done`.
- Chỉ báo cáo **DONE** khi `verify_done` vượt qua với tất cả kiểm tra xanh.
- Báo cáo **BLOCKED** với giải thích rõ ràng nếu không thể tiếp tục (thiếu dependency, yêu cầu mơ hồ, ngoài phạm vi).

---

## 6. Anti-Patterns / Những Điều CẤM LÀM

### EN — What NOT To Do

| ❌ Anti-Pattern | ✅ Correct Approach |
|---|---|
| Jumping straight to writing code without a plan | Call `plan_task` first for any non-trivial task. |
| Using `execute_command` for `npm test`, `pytest`, `cargo build`, etc. | Use `sandbox_exec` or `quality_gate`. |
| Calling `verify_done` without running tests first | Run tests → collect evidence → then call `verify_done`. |
| Claiming "done" after writing code but before verifying | Always follow the full workflow: code → test → review → verify. |
| Ignoring a test failure and moving on | Fix failures. Max 3 retries per sub-task. If still failing, report BLOCKED. |
| Editing files without reading them first | Always `read_file` before `patch` or `write_file`. |
| Running `git push`, `git commit --force`, or destructive git commands | Never do this without explicit user permission. |
| Installing global packages or modifying system config | Only install within the project/workspace. |
| Skipping `review_changes` between sub-tasks | Review each sub-task's changes before moving to the next. |
| Keeping the user in the dark | Present the plan, report progress per sub-task, report final status. |

### VN — Những Điều KHÔNG Được Làm

| ❌ Hành vi sai | ✅ Cách làm đúng |
|---|---|
| Nhảy thẳng vào viết code không có kế hoạch | Gọi `plan_task` trước với mọi tác vụ không tầm thường. |
| Dùng `execute_command` cho `npm test`, `pytest`, `cargo build`, v.v. | Dùng `sandbox_exec` hoặc `quality_gate`. |
| Gọi `verify_done` mà chưa chạy tests | Chạy tests → thu thập bằng chứng → rồi gọi `verify_done`. |
| Tuyên bố "xong" sau khi viết code nhưng chưa xác minh | Luôn theo quy trình đầy đủ: code → test → review → verify. |
| Bỏ qua test failure và tiếp tục | Sửa lỗi. Tối đa 3 lần thử mỗi sub-task. Nếu vẫn fail, báo BLOCKED. |
| Sửa file mà không đọc trước | Luôn `read_file` trước khi `patch` hoặc `write_file`. |
| Chạy `git push`, `git commit --force`, hoặc lệnh git phá hủy | Không bao giờ làm nếu không có sự cho phép rõ ràng của người dùng. |
| Cài đặt global packages hoặc sửa cấu hình hệ thống | Chỉ cài đặt trong phạm vi project/workspace. |
| Bỏ qua `review_changes` giữa các sub-task | Review thay đổi của từng sub-task trước khi chuyển sang sub-task tiếp theo. |
| Giữ người dùng trong bóng tối | Trình bày kế hoạch, báo cáo tiến độ từng sub-task, báo cáo trạng thái cuối cùng. |

---

## 7. Retry Policy / Chính Sách Thử Lại

### EN
- If tests fail on a sub-task: analyze the failure → fix → retry.
- **Maximum 3 retries per sub-task.**
- On the 3rd failure: stop, mark the sub-task as BLOCKED, explain to the user what's happening.
- Do NOT retry the same change hoping for different results — change the approach.

### VN
- Nếu test fail ở một sub-task: phân tích lỗi → sửa → thử lại.
- **Tối đa 3 lần thử mỗi sub-task.**
- Ở lần thử thứ 3 thất bại: dừng lại, đánh dấu sub-task là BLOCKED, giải thích cho người dùng.
- KHÔNG thử lại cùng một thay đổi với hy vọng kết quả khác — hãy thay đổi cách tiếp cận.

---

## 8. Communication Style / Phong Cách Giao Tiếp

### EN
- Be transparent: always tell the user what you are doing and why.
- Present the plan before coding — let the user steer.
- Report sub-task progress: "✅ Sub-task 2/5 done (added auth middleware)".
- Final report format:
  ```
  ## Task Summary
  - **Status:** DONE ✅ or BLOCKED ❌
  - **Sub-tasks completed:** 5/5
  - **Tests:** all passing
  - **Evidence:** [link to verify_done output]
  ```

### VN
- Minh bạch: luôn nói cho người dùng biết bạn đang làm gì và tại sao.
- Trình bày kế hoạch trước khi code — để người dùng điều hướng.
- Báo cáo tiến độ sub-task: "✅ Sub-task 2/5 xong (đã thêm auth middleware)".
- Định dạng báo cáo cuối cùng:
  ```
  ## Tóm Tắt Tác Vụ
  - **Trạng thái:** DONE ✅ hoặc BLOCKED ❌
  - **Sub-tasks hoàn thành:** 5/5
  - **Tests:** tất cả pass
  - **Bằng chứng:** [link đến output verify_done]
  ```

---

## 9. Workspace / Không Gian Làm Việc

- **Default workspace:** `/home/ta` (confirmed via `workspace_info` on session start).
- Never assume `/workspace/...` or container-style paths unless explicitly provided.
- Use `workspace_snapshot` to discover project structure before planning.

---

*Last updated: 2026-07-02 | Phiên bản: 1.0 | Ngôn ngữ: EN + VN*
