# Cache & Diff — Trạng thái triển khai

> **Hầu hết đã implement. Xem chi tiết bên dưới.**

## Đã implement ✅

### 1. Hash cache (Section 2.2, 2.3, 2.4)

- [x] Lưu hash map thay vì full JSON array
- [x] Chỉ hash message role `user` | `tool`
- [x] Hash lookup O(1) thay vì `computeDiff` O(n)
- [x] `parent_message_id` để xử lý revert không tạo session mới

**Code**: `packages/backend/src/providers/core/hash.ts`

### 2. Tools hash riêng biệt (Section 2.5)

- [x] Cột `tools_hash` trong bảng `conversations` (migration version 7)
- [x] So sánh `tools_hash` mới với DB, chỉ gửi tool prompt khi thay đổi
- [x] System prompt block `[#llmweb2api:tools]` chứa tool definitions

**Code**: `packages/backend/src/providers/core/hash.ts:35-38`

### 3. `last_message_id` (Bổ sung cuối file)

- [x] Cột `last_message_id` trong bảng `conversations`
- [x] Lưu ID message cuối từ assistant response
- [x] Dùng làm `parent_message_id` cho message mới (không phải edit)
- [x] Đảm bảo chain message đúng khi hash chỉ lưu role user/tool

**Code**: `packages/backend/src/app/models/conversation.ts:70-86`

### 4. Lưu cache khi stream chưa kết thúc (Section 2.6)

- [x] Stream: lưu hash ngay khi có chunk đầu tiên (`updateHashCacheParentId`)
- [x] Non-stream: lưu sau khi nhận response

### 5. Session reuse

- [x] `sessionStore` Map lưu session theo `conversationId`
- [x] Session được tái sử dụng giữa các request cache
- [x] Mỗi conversation có `providerSessionId` riêng

**Code**: `packages/backend/src/providers/core/manager.ts:27-55`

## Chưa implement / Khác biệt

### Không dùng `edit_message` API của DeepSeek

Hiện tại flow không gọi `edit_message` API của DeepSeek. Thay vào đó:
- Khi revert: gửi message mới với `parent_message_id` của message trước điểm phân kỳ (tạo branch tự nhiên trong session)
- Khi full match: gửi lại message cuối như message mới (regenerate)

### Không có `lastest_message_id` như mô tả bổ sung

Thay vào đó dùng `last_message_id` — lưu message ID cuối cùng từ assistant response bên provider, dùng làm parent cho request tiếp theo.
