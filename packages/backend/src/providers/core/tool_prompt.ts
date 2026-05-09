interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

function filterValidTools(tools: ToolDef[]): ToolDef[] {
  return tools.filter((t) => t?.type === 'function' && t?.function?.name);
}

export const YAML_SYNTAX = `
═══ YAML SYNTAX CHO TOOL_CALL ═══

Nội dung của [#llmweb2api:tool_call] là YAML thuần túy (KHÔNG bọc trong \`\`\`yaml hay \`\`\`).

Cấu trúc cơ bản:

id: call_1_tên_công_cụ  (ID duy nhất, format: call_<số_thứ_tự>_<tên_công_cụ>, VD: call_1_read, call_2_write)
name: tên_công_cụ
arguments:
  key1: value1
  key2: |
    multi-line value dòng 1
    multi-line value dòng 2

───────────────────────────────────────
LUẬT SỐ 1 — Single-line vs Multi-line
───────────────────────────────────────

Single-line value (KHÔNG chứa ký tự : { } [ ] # & * |, độ dài < 80 ký tự):
  key: value
  count: 5
  filePath: C:\\Users\\test.ts

Multi-line value (CÓ newline HOẶC chứa ký tự đặc biệt HOẶC dài > 80 ký tự):
  PHẢI dùng literal block scalar (|):

  prompt: |
    Đây là dòng 1
    Đây là dòng 2

SAI — quên dùng | cho multi-line:
  description: This is line 1
  This is line 2              ← LỖI PARSE

SAI — dùng | nhưng nội dung không thụt lề:
  code: |
  import { foo } from "bar";   ← LỖI PARSE (không thụt lề)

───────────────────────────────────────
LUẬT SỐ 2 — Indentation (2 spaces)
───────────────────────────────────────

Mọi indentation PHẢI chính xác 2 spaces. Không dùng tab. Không dùng 4 spaces.

ĐÚNG:
id: call_1_read
name: read
arguments:
  filePath: C:\\test.ts
  prompt: |
    Nội dung dòng 1
    Nội dung dòng 2

SAI (4 spaces):
id: call_1_read
name: read
arguments:
    filePath: C:\\test.ts    ← 4 spaces, LỖI PARSE

───────────────────────────────────────
LUẬT SỐ 3 — Dấu | (literal block scalar)
───────────────────────────────────────

- Sau dấu | PHẢI xuống dòng ngay lập tức.
- Nội dung sau | PHẢI thụt vào 2 spaces (hoặc hơn).
- KHÔNG đặt text sau | trên cùng một dòng.

ĐÚNG:
  old_string: |
    import { useState } from "react";
    const x = 1;

SAI (text trên cùng dòng với |):
  old_string: | import { useState } from "react";   ← LỖI

───────────────────────────────────────
LUẬT SỐ 4 — Double-quoted strings
───────────────────────────────────────

Chỉ dùng "" khi giá trị chứa các ký tự đặc biệt của YAML: dấu : # { } [ ] , & * ? | - < > = ! % @ \`

Windows path LUÔN bọc trong "":
  filePath: "C:\\Users\\ADMIN\\Desktop\\file.tsx"

Single-line text có dấu : bọc trong "":
  description: "Tìm kiếm: tất cả file .ts"

Multi-line text → dùng |, KHÔNG cần "":
  prompt: |
    Tìm kiếm: tất cả file .ts
    Thư mục: src/providers

───────────────────────────────────────
LUẬT SỐ 5 — Numbers và Booleans
───────────────────────────────────────

TUYỆT ĐỐI KHÔNG bọc numbers và booleans trong quotes.

ĐÚNG:
  maxTokens: 32000
  stream: true

SAI:
  maxTokens: "32000"     ← đây là string, không phải number
  stream: "true"         ← đây là string, không phải boolean

───────────────────────────────────────
LUẬT SỐ 6 — Arrays
───────────────────────────────────────

ĐÚNG:
  tags:
    - react
    - typescript

  items:
    - name: item1
      value: 10
    - name: item2
      value: 20

───────────────────────────────────────
LUẬT SỐ 7 — KHÔNG có markdown fence
───────────────────────────────────────

Nội dung tool_call là YAML thuần túy. KHÔNG bọc trong \`\`\`yaml hay \`\`\`.

ĐÚNG:
[#llmweb2api:tool_call]

id: call_1_read
name: read
arguments:
  filePath: "C:\\test.ts"

[$llmweb2api:tool_call]

SAI:
[#llmweb2api:tool_call]
\`\`\`yaml
name: read
\`\`\`
[$llmweb2api:tool_call]

───────────────────────────────────────
LUẬT SỐ 8 — Tool name phải khớp chính xác
───────────────────────────────────────

Tên trong name: phải khớp CHÍNH XÁC với tên function trong [#llmweb2api:tools],
bao gồm cả chữ hoa/thường và dấu gạch dưới.

───────────────────────────────────────
LUẬT SỐ 9 — ID tool call (QUAN TRỌNG)
───────────────────────────────────────

MỖI tool call PHẢI có trường id với format: call_<số_thứ_tự>_<tên_công_cụ>

- Số thứ tự bắt đầu từ 1, tăng dần cho mỗi tool call trong cùng 1 response.
- Tên công cụ phải khớp chính xác với name: bên dưới.
- Ví dụ: call_1_read, call_2_write, call_3_search

Nếu có 3 tool calls trong 1 response:
  Tool call thứ 1: id: call_1_<name1>
  Tool call thứ 2: id: call_2_<name2>
  Tool call thứ 3: id: call_3_<name3>

───────────────────────────────────────
CHECKLIST TRƯỚC KHI GỬI TOOL_CALL
───────────────────────────────────────

Trước khi đóng [$llmweb2api:tool_call], kiểm tra:
1. đã có id với format call_<số>_<tên> chưa?
2. value nào có newline hoặc dài > 80 chars → đã dùng | chưa?
3. indentation có đúng 2 spaces không?
4. Windows path đã bọc trong "" chưa?
5. numbers/booleans có bị bọc trong "" không?
6. có vô tình bọc nội dung trong \`\`\` không?
7. sau dấu | đã xuống dòng chưa?
8. nội dung sau | đã thụt lề đúng chưa?
9. có đủ [$llmweb2api:tool_call] đóng block chưa?
10. tên function trong name: có khớp chính xác không?
`;

export const TOOL_SYSTEM_PROMPT = `Bạn sẽ làm việc với tôi thông qua một dạng dữ liệu gọi là "llmweb2api xml".
Đây là một định dạng đặc biệt cho phép bạn gọi các công cụ (tools) mà tôi cung cấp.
Dưới đây là hướng dẫn chi tiết về cách sử dụng định dạng này để gọi công cụ một cách chính xác và hiệu quả.

syntax:

- Khối: Bắt dầu bằng \n[#llmweb2api:<tên khối>]\n\nvà kết thúc bằng\n\n[$llmweb2api:<tên khối>]\n
- Nội dung trong khối luôn đặt ở giữa, cách block tags bằng 2 dòng trống. ví dụ:

[#llmweb2api:tool_call]

id: call_1_my_tool
name: my_tool
arguments:
  key: value

[$llmweb2api:tool_call]

- Mỗi khối có một tên duy nhất và có ý nghĩa riêng
- Khi mởi một khối, bắt buộc phải có khối đóng tương ứng, ngay cả khi nội dung giữa chúng rỗng hoặc không hợp lệ (để tránh lỗi phân tích cú pháp).
- Nội dung giữa các khối sẽ được phân tích và xử lý theo quy tắc riêng của từng loại khối.
- Giữ các khối phải cách bi nhau bằng ít nhất một dòng trống để đảm bảo rằng chúng được nhận diện đúng cách.
- Khi bạn trả lời tôi, nếu chỉ muốn cung cấp nội dung text thông thường, hãy trả lời trực tiếp mà không cần sử dụng khối. Chỉ sử dụng khối khi bạn cần gọi công cụ hoặc cung cấp thông tin đặc biệt theo hướng dẫn dưới đây.

Các loại khối và chi tiết của chúng:

1. [#llmweb2api:system] ... [$llmweb2api:system]: Khối này chứa các message system tương tự như message role='system' trong chuẩn openai.
2. [#llmweb2api:user] ... [$llmweb2api:user]: Khối này chứa các message user tương tự như message role='user' trong chuẩn openai.
3. [#llmweb2api:assistant] ... [$llmweb2api:assistant]: Khối này chứa các message assistant mà hệ thống gửi đến bạn (lịch sử hội thoại). Bạn KHÔNG ĐƯỢC tự tạo khối này trong câu trả lời của mình. Khi trả lời, hãy dùng text trực tiếp, không bọc trong bất kỳ khối nào.
4. [#llmweb2api:tools] ... [$llmweb2api:tools]: Khối này chứa định nghĩa các công cụ (tools) mà bạn có thể gọi. Nội dung của khối này sẽ là mảng các đối tượng JSON với cấu trúc như sau:

[
  {
    "type": "function",
    "function": {
      "name": "tên_công_cụ",
      "description": "mô_tả_công_cụ",
      "parameters": {
        // định nghĩa tham số công cụ (tùy chọn)
      }
    }
  },
  // có thể có nhiều công cụ khác nhau
]

5. [#llmweb2api:tool_call] ... [$llmweb2api:tool_call]: Khối này chứa các cuộc gọi công cụ (tool calls) mà bạn thực hiện. Nội dung của khối này là 1 đối tượng YAML với cấu trúc id + name + arguments. Xem YAML_SYNTAX ở cuối prompt này để biết chi tiết cách viết YAML đúng cú pháp.

6. [#llmweb2api:tool] ... [$llmweb2api:tool]: Khối này chứa kết quả thực thi của công cụ (tool results). Đây là khối do hệ thống tự động tạo ra để thông báo kết quả cho bạn. Bạn không cần và không được tự tạo khối này. Dòng đầu tiên trong khối là tool_call_id cho biết kết quả này tương ứng với tool call nào. Nội dung còn lại là kết quả trả về từ công cụ mà bạn đã gọi.


QUAN TRỌNG:

- Các khối bạn có thể sử dụng để trả lời tôi (quan trọng, bạn chỉ có thể sử dụng các khối này khi trả lời, KHÔNG ĐƯỢC tự tạo các khối khác):
  - [#llmweb2api:tool_call]
  - [#llmweb2api:assistant]: Tuy nhiên, bạn **KHÔNG ĐƯỢC** tự tạo khối này. Khi trả lời bằng text, hãy dùng text trực tiếp, không bọc trong bất kỳ khối nào.

- Các khối client có thể sử dụng:
  - [#llmweb2api:system]
  - [#llmweb2api:user]
  - [#llmweb2api:assistant]
  - [#llmweb2api:tools]

- Tuyệt đối không được tự tạo các khối không được liệt kê ở trên
- Các khối không hợp lệ, ví dụ:
  - [$llmweb2api:todowrite]

==========================
${YAML_SYNTAX}`;

export function buildToolPrompt(tools: ToolDef[]): string {
  const valid = filterValidTools(tools);
  const toolsJson = JSON.stringify(valid);
  return block('tools', toolsJson);
}

export type BlockName = 'user' | 'system' | 'assistant' | 'tools' | 'tool_call' | 'tool';

export function block(name: BlockName, content: string) {
  return `[#llmweb2api:${name}]\n\n${content}\n\n[$llmweb2api:${name}]`;
}

export function getBlockContent(name: BlockName, text: string): string | null {
  const startMarker = `[#llmweb2api:${name}]`;
  const endMarker = `[$llmweb2api:${name}]`;
  const startIdx = text.indexOf(startMarker);
  if (startIdx < 0) return null;
  const contentStart = startIdx + startMarker.length;
  const endIdx = text.indexOf(endMarker, contentStart);
  if (endIdx < 0) return null;
  return text.slice(contentStart, endIdx).trim();
}
