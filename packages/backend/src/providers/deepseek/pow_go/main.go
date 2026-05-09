package main

import (
	"encoding/base64"
	"encoding/json"
	"syscall/js"
)

// solvePowJS là hàm được export ra JavaScript.
// Gọi: globalThis.__powSolvePow(challengeHex, salt, expireAt, difficulty)
// Trả về: JSON string {"answer": 12345} hoặc {"error": "message"}
func solvePowJS(this js.Value, args []js.Value) interface{} {
	if len(args) < 4 {
		return `{"error":"solvePow: expected 4 args (challengeHex, salt, expireAt, difficulty)"}`
	}
	challengeHex := args[0].String()
	salt := args[1].String()
	expireAt := int64(args[2].Int())
	difficulty := int64(args[3].Int())

	answer, err := solvePowRaw(challengeHex, salt, expireAt, difficulty)
	if err != nil {
		return `{"error":"` + err.Error() + `"}`
	}

	result := map[string]int64{"answer": answer}
	b, _ := json.Marshal(result)
	return string(b)
}

// buildPowHeaderJS tạo x-ds-pow-response header.
// Gọi: globalThis.__powBuildHeader(algo, challenge, salt, answer, signature, targetPath)
// Trả về: base64 encoded JSON string
func buildPowHeaderJS(this js.Value, args []js.Value) interface{} {
	if len(args) < 6 {
		return `{"error":"buildPowHeader: expected 6 args"}`
	}

	payload := map[string]interface{}{
		"algorithm":   args[0].String(),
		"challenge":   args[1].String(),
		"salt":        args[2].String(),
		"answer":      args[3].Int(),
		"signature":   args[4].String(),
		"target_path": args[5].String(),
	}

	b, err := json.Marshal(payload)
	if err != nil {
		return `{"error":"` + err.Error() + `"}`
	}

	return base64.StdEncoding.EncodeToString(b)
}

func main() {
	// Đăng ký các hàm vào global scope của JavaScript
	js.Global().Set("__powSolvePow", js.FuncOf(solvePowJS))
	js.Global().Set("__powBuildHeader", js.FuncOf(buildPowHeaderJS))

	// Giữ Go runtime alive (block forever)
	select {}
}
