# Đã implement: Xóa conversation dựa trên last_used

> **Trạng thái: ĐÃ HOÀN THÀNH**

## Tóm tắt giải pháp

- ~~Trước đây: xóa conversation theo `created_at`, nếu người dùng dùng liên tục conversation đó thì nó vẫn bị xóa, gây mất cache không mong muốn.~~
- **Hiện tại**: Đã thêm column `last_used` (migration version 6).
  - `last_used` được cập nhật mỗi khi có request vào conversation (trong `saveConversation` và `saveHashCache`).
  - Logic dọn dẹp (`deleteOldConversations`) query dựa trên `last_used < datetime('now', '-maxAgeHours hours')`.
  - Conversation chỉ bị xóa khi **không được dùng** trong khoảng thời gian retention đã đặt.

## Code location

- `packages/backend/src/app/models/conversation.ts:131-135` — cleanup query
- `packages/backend/src/app/database.ts:254-259` — migration add `last_used`
