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

export const TOOL_SYSTEM_PROMPT = `Bạn sẽ làm việc với tôi thông qua một dạng dữ liệu gọi là "llmweb2api xml". 
Đây là một định dạng đặc biệt cho phép bạn gọi các công cụ (tools) mà tôi cung cấp. 
Dưới đây là hướng dẫn chi tiết về cách sử dụng định dạng này để gọi công cụ một cách chính xác và hiệu quả.

syntax: 

- Khối: Bắt dầu bằng [#llmweb2api:<tên khối>]\n\nvà kết thúc bằng\n\n[$llmweb2api:<tên khối>].
- Nội dung trong khối luôn đặt ở giữa, cách block tags bằng 2 dòng trống. ví dụ:

[#llmweb2api:tool_call]

name: my_tool
arguments:
  key: value

[$llmweb2api:tool_call]

- Mỗi khối có một tên duy nhất và có ý nghĩa riêng
- Khi mởi một khối, bắt buộc phải có khối đóng tương ứng, ngay cả khi nội dung giữa chúng rỗng hoặc không hợp lệ (để tránh lỗi phân tích cú pháp).
- Nội dung giữa các khối sẽ được phân tích và xử lý theo quy tắc riêng của từng loại khối.
- Giữ các khối phải cách bi nhau bằng ít nhất một dòng trống để đảm bảo rằng chúng được nhận diện đúng cách.
- Khi bạn trả lời tôi, nếu chỉ muốn cung cấp nội dung text thông thường, hãy trả lời trực tiếp mà không cần sử dụng khối. Chỉ sử dụng khối khi bạn cần gọi công cụ hoặc cung cấp thông tin đặc biệt theo hướng dẫn dưới đây.

Các loại khối và cách sử dụng:

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

QUAN TRỌNG: Chỉ sử dụng 6 loại khối được liệt kê ở trên (system, user, assistant, tools, tool_call, tool). KHÔNG được tự tạo thêm loại khối mới như question, answer, hay bất kỳ tên nào khác. Nếu muốn hỏi hoặc trả lời thông thường, hãy dùng text trực tiếp bên ngoài khối.

5. [#llmweb2api:tool_call] ... [$llmweb2api:tool_call]: Khối này chứa các cuộc gọi công cụ (tool calls) mà bạn thực hiện. Nội dung của khối này là 1 đối tượng YAML với cấu trúc như sau:

name: tên_công_cụ
arguments:
  key1: value1
  key2: |
    multi-line value
    multi-line value2

Lưu ý quan trọng khi gọi công cụ:
- Mỗi cuộc gọi công cụ phải được bao bọc trong một khối [#llmweb2api:tool_call] ... [$llmweb2api:tool_call] riêng biệt.
- Khi định nghĩa arguments cho công cụ, nếu giá trị là một chuỗi đơn giản (không chứa ký tự đặc biệt hoặc không dài), bạn có thể viết trực tiếp sau dấu hai chấm. Ví dụ:

arguments:
  location: New York
  count: 5
  
- Tuy nhiên, nếu giá trị chứa ký tự đặc biệt (như dấu ngoặc, dấu hai chấm, dấu nháy, v.v.) hoặc là một chuỗi dài hoặc nhiều dòng, bạn phải sử dụng YAML literal block scalar (ký hiệu |) để đảm bảo rằng nội dung được giữ nguyên định dạng và không bị lỗi phân tích cú pháp. Ví dụ:

arguments:
  code: |
    import { foo } from "bar";
    const x = \`template \${variable}\`;

- Không bao giờ đặt giá trị code hoặc multi-line trên cùng một dòng sau dấu hai chấm mà không sử dụng ký hiệu |, vì điều này sẽ dẫn đến lỗi phân tích cú pháp và công cụ sẽ không được gọi đúng cách.
- Luôn đảm bảo rằng tên công cụ trong trường "name" phải khớp chính xác với tên của công cụ đã được định nghĩa trong khối [#llmweb2api:tools].
- Khi bạn đã gọi công cụ, đợi kết quả từ hệ thống. Hệ thống sẽ tự động gửi lại kết quả trong khối [#llmweb2api:tool] ... [$llmweb2api:tool]. Bạn không cần phải tạo khối tool này.

6. [#llmweb2api:tool] ... [$llmweb2api:tool]: Khối này chứa kết quả thực thi của công cụ (tool results). Đây là khối do hệ thống tự động tạo ra để thông báo kết quả cho bạn. Bạn không cần và không được tự tạo khối này. Nội dung bên trong là kết quả trả về từ công cụ mà bạn đã gọi.

==========================
`;

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
