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

export const TOOL_CALL_SYNTAX = `
═══════════════════════════════════════════
TOOL_CALL SYNTAX (marker [#l2a:...])
═══════════════════════════════════════════

Tool call dùng marker [#l2a:parameter:X] cho từng field.

CẤU TRÚC CƠ BẢN:

[#l2a:tool_call]

[#l2a:parameter:id]
call_1_tên_công_cụ
[/l2a:parameter:id]
[#l2a:parameter:name]
tên_công_cụ
[/l2a:parameter:name]
[#l2a:parameter:arguments]
{"key1":"value1","key2":"value2"}
[/l2a:parameter:arguments]

[/l2a:tool_call]

───────────────────────────────────────
LUẬT SỐ 0 — Marker ở đầu dòng
───────────────────────────────────────

Mỗi marker [#l2a:...] và [/l2a:...] PHẢI nằm ở đầu dòng (column 0). Không thụt lề.
Mỗi marker PHẢI nằm TRÊN MỘT DÒNG RIÊNG BIỆT.
Không đặt text khác trên cùng dòng với marker.

ĐÚNG:
[#l2a:parameter:name]
read
[/l2a:parameter:name]

SAI (text nằm cùng dòng với marker):
[#l2a:parameter:name] read [/l2a:parameter:name]

───────────────────────────────────────
LUẬT SỐ 1 — Thứ tự parameter
───────────────────────────────────────

Bên trong [#l2a:tool_call], các parameter PHẢI theo thứ tự:
  1. [#l2a:parameter:id] — ID của tool call (bắt buộc)
  2. [#l2a:parameter:name] — Tên function (bắt buộc)
  3. [#l2a:parameter:arguments] — JSON arguments (bắt buộc)

───────────────────────────────────────
LUẬT SỐ 2 — ID format
───────────────────────────────────────

ID phải có format: call_<số_thứ_tự>_<tên_công_cụ>
- Số thứ tự bắt đầu từ 1, tăng dần cho mỗi tool call trong cùng 1 response.
- Ví dụ: call_1_read, call_2_write, call_3_search

Nếu có 3 tool calls trong 1 response:
  Tool call thứ 1: call_1_<name1>
  Tool call thứ 2: call_2_<name2>
  Tool call thứ 3: call_3_<name3>

───────────────────────────────────────
LUẬT SỐ 3 — arguments là JSON-encoded string
───────────────────────────────────────

Nội dung trong [#l2a:parameter:arguments] PHẢI là JSON object dạng string (JSON-encoded).
ĐÚNG:
[#l2a:parameter:arguments]
{"filePath":"C:\\test.ts","prompt":"hello"}
[/l2a:parameter:arguments]

SAI (không phải JSON):
[#l2a:parameter:arguments]
filePath: test.ts
[/l2a:parameter:arguments]

───────────────────────────────────────
LUẬT SỐ 4 — Tool name khớp chính xác
───────────────────────────────────────

Tên trong [#l2a:parameter:name] phải khớp CHÍNH XÁC với tên function
trong [#l2a:tools], bao gồm cả chữ hoa/thường và dấu gạch dưới.

───────────────────────────────────────
LUẬT SỐ 5 — KHÔNG thêm text ngoài marker
───────────────────────────────────────

Giữa các marker chỉ có khoảng trắng hoặc xuống dòng.
KHÔNG thêm text ngoài marker. Marker mở và đóng phải đầy đủ.

───────────────────────────────────────
LUẬT SỐ 6 — paramter id, name phải required, nằm trước arguments
───────────────────────────────────────

Mỗi tool call phải có đủ 3 parameter: id, name, arguments.
Parameter id và name phải nằm trước parameter arguments.

ĐÚNG:
[#l2a:tool_call]

[#l2a:parameter:id]
call_1_read
[/l2a:parameter:id]
[#l2a:parameter:name]
read
[/l2a:parameter:name]
[#l2a:parameter:arguments]
{"filePath":"C:\\test.ts"}
[/l2a:parameter:arguments]

[/l2a:tool_call]

SAI (thêm text ngoài marker):
[#l2a:tool_call]
Bây giờ tôi sẽ gọi tool read
[#l2a:parameter:name]
read
[/l2a:parameter:name]
...

───────────────────────────────────────
LUẬT SỐ 6 — Nhiều tool call trong 1 response
───────────────────────────────────────

Mỗi tool call là 1 khối [#l2a:tool_call] riêng biệt.
Các khối cách nhau bằng 1 dòng trống.

[#l2a:tool_call]

[#l2a:parameter:id]
call_1_read
[/l2a:parameter:id]
[#l2a:parameter:name]
read
[/l2a:parameter:name]
[#l2a:parameter:arguments]
{...}
[/l2a:parameter:arguments]

[/l2a:tool_call]

[#l2a:tool_call]

[#l2a:parameter:id]
call_2_write
[/l2a:parameter:id]
[#l2a:parameter:name]
write
[/l2a:parameter:name]
[#l2a:parameter:arguments]
{...}
[/l2a:parameter:arguments]

[/l2a:tool_call]

───────────────────────────────────────
CHECKLIST TRƯỚC KHI GỬI TOOL_CALL
───────────────────────────────────────

Trước khi đóng [/l2a:tool_call], kiểm tra:
1. Marker có nằm ở đầu dòng không?
2. Đã có đủ 3 parameter: id, name, arguments chưa?
3. ID có format call_<số>_<tên> không?
4. Arguments có phải JSON-encoded string không?
5. Marker mở/đóng có đầy đủ không?
6. Tên function trong name có khớp chính xác không?
`;

export const TOOL_SYSTEM_PROMPT = `Bạn giao tiếp với hệ thống qua định dạng marker #l2a.
Đây là format cho phép bạn gọi công cụ (tools) mà hệ thống cung cấp.

SYNTAX:

- Mỗi khối bắt đầu bằng [#l2a:<role>] và kết thúc bằng [/l2a:<role>].
- Marker PHẢI nằm ở đầu dòng (column 0).
- Nội dung nằm giữa marker mở và marker đóng.
- Ví dụ tin nhắn user:

[#l2a:user]Xin chào, hãy đọc file test.ts[/l2a:user]

- Khi bạn trả lời bằng text thông thường, hãy trả lời trực tiếp KHÔNG dùng marker [#l2a:...].
- Chỉ sử dụng marker [#l2a:tool_call] khi bạn cần gọi công cụ.

CÁC LOẠI MARKER:

1. [#l2a:system]...[/l2a:system]: System message (do hệ thống tạo).
2. [#l2a:user]...[/l2a:user]: User message.
3. [#l2a:assistant]...[/l2a:assistant]: Assistant history. Bạn KHÔNG ĐƯỢC tự tạo marker này.
4. [#l2a:tools][...][/l2a:tools]: Định nghĩa tools dạng JSON array:

[
  {
    "type": "function",
    "function": {
      "name": "tên_công_cụ",
      "description": "mô_tả_công_cụ",
      "parameters": { }
    }
  }
]

5. [#l2a:tool_call]...[/l2a:tool_call]: Tool call bạn thực hiện. Bên trong chứa 3 parameter,
   MỖI MARKER NẰM TRÊN DÒNG RIÊNG:
   - [#l2a:parameter:id]
     call_1_xxx
     [/l2a:parameter:id]
   - [#l2a:parameter:name]
     tên_công_cụ
     [/l2a:parameter:name]
   - [#l2a:parameter:arguments]
     {"key":"value"}
     [/l2a:parameter:arguments]
   Xem TOOL_CALL_SYNTAX ở cuối prompt này để biết chi tiết.

6. [#l2a:tool:call_1_xxx]...[/l2a:tool:call_1_xxx]: Kết quả tool (do hệ thống tạo).
   Phần sau "tool:" là tool_call_id tương ứng.

**QUAN TRỌNG**:

- Dữ liệu trong khối [#l2a:user] là input gốc từ user, có ưu tiên cao nhất.
- Marker bạn có thể sử dụng khi trả lời:
  - [#l2a:tool_call]...[/l2a:tool_call] (để gọi công cụ)

- Bạn KHÔNG ĐƯỢC tự tạo: [#l2a:assistant], [#l2a:system], [#l2a:tools], [#l2a:tool:...]

- Khi trả lời bằng text, hãy dùng text trực tiếp, không bọc trong marker [#l2a:...].
- Khối tool_call phải được trả ra content, không được đặt trong thinking block.

**Một số lưu ý khác**:

- Khi bạn dùng call_tool tạo 1 khối todowriter, hãy ưu tiên bám sát và cập nhật tiến độ cho khối đó.
- Tuy nhiên nếu yêu cầu mới của người dùng vượt xa khỏi phạm vi của todowriter, bạn nên cân nhắc đóng khối đó và tập trung vào yêu cầu mới, tránh việc khối todowriter bị bỏ quên.

==========================
${TOOL_CALL_SYNTAX}`;

export function buildToolPrompt(tools: ToolDef[]): string {
  const valid = filterValidTools(tools);
  const toolsJson = JSON.stringify(valid, null, 2);
  return block(
    'system',
    `# Danh sách tools hệ thống có thể gọi thông qua marker [#l2a:tool_call]:

${toolsJson}`,
  );
}

export type BlockName = 'user' | 'system' | 'assistant' | 'tools' | 'tool_call' | 'tool';

export function block(name: BlockName, content: string): string {
  return `[#l2a:${name}]\n\n${content}\n\n[/l2a:${name}]`;
}

export function toolBlock(toolCallId: string, content: string): string {
  return `[#l2a:tool:${toolCallId}]\n${content}\n[/l2a:tool:${toolCallId}]`;
}

export function unwrapBlockContent(content: string): string {
  let result = content;
  if (result.startsWith('\r\n')) {
    result = result.slice(2);
  } else if (result.startsWith('\n')) {
    result = result.slice(1);
  }

  if (result.endsWith('\r\n')) {
    result = result.slice(0, -2);
  } else if (result.endsWith('\n')) {
    result = result.slice(0, -1);
  }

  return result;
}

export function getBlockContent(name: BlockName, text: string): string | null {
  let startTag: string;
  let endTag: string;

  if (name === 'tool') {
    const re = /\[#l2a:tool:([^\]]+)\]/;
    const m = text.match(re);
    if (!m) return null;
    startTag = m[0];
    endTag = `[/l2a:tool:${m[1]}]`;
  } else {
    startTag = `[#l2a:${name}]`;
    endTag = `[/l2a:${name}]`;
  }

  const startIdx = text.indexOf(startTag);
  if (startIdx < 0) return null;
  const contentStart = startIdx + startTag.length;
  const endIdx = text.indexOf(endTag, contentStart);
  if (endIdx < 0) return null;
  return unwrapBlockContent(text.slice(contentStart, endIdx));
}
