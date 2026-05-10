## Trạng thái các task

- [x] ~~1. Thường xuyên tạo todo xong bị quên không update trạng thái, vì chúng ta chat và chỉ gửi message mới, nên model rất dễ bị quên~~
      → Đã xử lý: hash-based cache + `last_message_id` giúp duy trì context chính xác qua các request.

- [x] ~~2. Hiện tại có nhiều logs quá, thêm 1 setting trong cài đặt, gọi là bật full logs, nếu bật thì sẽ logs full như hiện tại, không thì chỉ logs cơ bản thôi~~
      → Đã implement: setting `log_level` trong Settings page. Mặc định `basic`, có thể chọn `full`.

- [x] ~~3. file upload name luôn bắt đầu bằng deepseek* => sửa lại thành llmweb2api*~~
      → Đã sửa: file upload name dùng prefix `llmweb2api_`.
