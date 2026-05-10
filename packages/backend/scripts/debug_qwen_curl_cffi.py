import json
import os
import sys
import time
import uuid
from pathlib import Path

try:
    from curl_cffi import requests
except ModuleNotFoundError:
    tmp_deps = Path(r"C:\tmp\qwen-curl-cffi")
    if tmp_deps.exists():
        sys.path.insert(0, str(tmp_deps))
        from curl_cffi import requests
    else:
        raise


BASE_URL = "https://chat.qwen.ai"
MODEL = sys.argv[1] if len(sys.argv) > 1 else "qwen3.6-plus"
PROMPT = " ".join(sys.argv[2:]) or "Reply with exactly: hello from qwen sse"


def load_env() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    env_file = repo_root / ".env"
    if not env_file.exists():
        env_file = repo_root.parent.parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if not line or line.strip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def build_headers(token: str, accept: str = "application/json, text/plain, */*") -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": accept,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": f"{BASE_URL}/",
        "Origin": BASE_URL,
        "Connection": "keep-alive",
        "Content-Type": "application/json",
    }


def build_payload(chat_id: str) -> dict:
    timestamp = int(time.time())
    return {
        "stream": True,
        "version": "2.1",
        "incremental_output": True,
        "chat_id": chat_id,
        "chat_mode": "normal",
        "model": MODEL,
        "parent_id": None,
        "messages": [
            {
                "fid": str(uuid.uuid4()),
                "parentId": None,
                "childrenIds": [str(uuid.uuid4())],
                "role": "user",
                "content": PROMPT,
                "user_action": "chat",
                "files": [],
                "timestamp": timestamp,
                "models": [MODEL],
                "chat_type": "t2t",
                "feature_config": {
                    "thinking_enabled": True,
                    "output_schema": "phase",
                    "research_mode": "normal",
                    "auto_thinking": True,
                    "thinking_mode": "Auto",
                    "thinking_format": "summary",
                    "auto_search": False,
                    "function_calling": False,
                    "enable_tools": False,
                    "enable_function_call": False,
                    "tool_choice": "none",
                },
                "extra": {"meta": {"subChatType": "t2t"}},
                "sub_chat_type": "t2t",
                "parent_id": None,
            }
        ],
        "timestamp": timestamp,
    }


def main() -> None:
    load_env()
    token = os.environ.get("QWEN_TOKEN")
    if not token:
        raise RuntimeError("Missing QWEN_TOKEN in .env")

    session = requests.Session(impersonate="chrome124", timeout=60)
    create_body = {
        "title": f"api_{int(time.time())}",
        "models": [MODEL],
        "chat_mode": "normal",
        "chat_type": "t2t",
        "timestamp": int(time.time()),
    }
    create_response = session.post(
        f"{BASE_URL}/api/v2/chats/new",
        headers=build_headers(token),
        json=create_body,
    )
    print("[create]", create_response.status_code, create_response.text[:500])
    create_response.raise_for_status()
    chat_id = create_response.json()["data"]["id"]

    with session.stream(
        "POST",
        f"{BASE_URL}/api/v2/chat/completions?chat_id={chat_id}",
        headers=build_headers(token, accept="text/event-stream"),
        data=json.dumps(build_payload(chat_id), ensure_ascii=False).encode("utf-8"),
    ) as response:
        print("[completion]", response.status_code, response.headers.get("content-type"))
        response.raise_for_status()
        for index, chunk in enumerate(response.iter_content()):
            if not chunk:
                continue
            print("[chunk]", chunk.decode("utf-8", errors="replace")[:1000].replace("\n", "\\n"))
            if index >= 20:
                break


if __name__ == "__main__":
    main()
