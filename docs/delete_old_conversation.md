- hiện tại xoá conversation theo thời gian tạo, nghĩa là tính từ thời điểm tạo nếu vượt quá thời gian cho phép thì xoá

vấn đề: nếu người dùng dùng liên tục conversation đó thì nó vẫn bị xoá, gây mất cache không mon muốn.

Giải pháp: thêm column last_used vào, logic xoá sẽ check theo file này, điều này đảm bảo conversation chỉ bị xoá khi không dùng sau khoảng thời gian đã đặt. mỗi khi có request vào conversation này thì update last_used
