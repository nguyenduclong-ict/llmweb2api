1. Thường xuyên tạo todo xong bị quên không update trạng thái, vì chúng ta chat và chỉ gửi message mới, nên model rất dễ bị quên

=> phương án, check list message gửi lên, nếu có todo chưa hoàn thành thì inject nó vào đầu message khi có message role=user hoặc role=tool

2. Hiện tại có nhiều logs quá, thêm 1 setting trong cài đặt, gọi là bật full logs, nếu bật thì sẽ logs full như hiện tại, không thì chỉ logs cơ bản thôi

3. file upload name luôn bắt đầu bằng deepseek* => sửa lại thành llmweb2api*
